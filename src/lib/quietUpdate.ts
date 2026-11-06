// Rituals fork (2026-11-06): apply a waiting Space build at the very start of
// a page load, never while the app runs.
//
// A waiting Service Worker only means a newer build of the Space exists; it is
// not an incompatibility (see pwaUpdate.ts). Before this, every returning
// person met a non-dismissible "A critical update is required" card after
// every release. Now src/main.jsx calls applyWaitingBuildAtStart() first in
// boot(), right after the frame-host check, and the newer build is activated
// there, with one reload, only when that interrupts nobody:
//   * nothing has started yet: the ticket is not redeemed, the account is not
//     checked, no identity database is open and the app has not rendered. The
//     pending ticket and the parent origin are in sessionStorage
//     (src/lib/ritualsSpace.js), so the reload keeps them;
//   * this page is controlled by the current worker and a newer one is
//     waiting. An uncontrolled page already came from the network;
//   * this is the only open Space page. Activation switches every page that
//     shares the worker, and the PWA plugin reloads each running app page.
//     Every page takes a shared Web Lock (TAB_PRESENCE_LOCK) here and holds it
//     for its lifetime, and the lock list tells a page whether it is alone.
//     Without the Web Locks API, or when the lock is not granted in time,
//     nothing is applied;
//   * a reload loop is impossible: at most one attempt per tab every
//     QUIET_UPDATE_RETRY_MS, and none when that guard cannot be stored.
// Otherwise the page boots its current, compatible build. The waiting worker
// takes over once every page using the old one has closed, or at a later
// boot that finds this page alone.
//
// This module imports only the diagnostics helper, which imports nothing, so
// it runs before any other app module. It does not read or write IndexedDB,
// localStorage, MLS state, vault state or authentication material: it keeps
// one sessionStorage timestamp and holds one shared Web Lock that guards
// nothing.

import { recordClientDiagnostic } from "./clientDiagnostics";

/** sessionStorage key holding when this tab last applied an update at boot. */
export const QUIET_UPDATE_STORAGE_KEY = "hush_sw_quiet_update_at";

/** A tab applies at most one update at boot in this window. */
export const QUIET_UPDATE_RETRY_MS = 2 * 60 * 1000;

/** Shared Web Lock every open Space page holds, so a page can tell if it is alone. */
export const TAB_PRESENCE_LOCK = "hush_sw_page_presence";

/** How long boot waits for the registration and for the lock grant. */
export const QUIET_UPDATE_STEP_TIMEOUT_MS = 1_000;

/** How long boot waits for the new worker to take control before reloading anyway. */
export const QUIET_UPDATE_ACTIVATE_TIMEOUT_MS = 5_000;

export type QuietUpdateOutcome =
  | "applied"
  | "unsupported"
  | "no-registration"
  | "none-waiting"
  | "uncontrolled"
  | "no-locks"
  | "lock-late"
  | "other-pages"
  | "recent"
  | "no-storage"
  | "post-failed"
  | "error";

export interface QuietUpdateOptions {
  /** Reloads the page once the new build has taken over. Injectable for tests. */
  reload?: () => void;
}

let presence: Promise<boolean> | null = null;

/** The Electron desktop renderer never registers the Service Worker. */
export function isDesktopRenderer(): boolean {
  if (typeof window === "undefined") return false;

  const desktopWindow = window as typeof window & {
    hushDesktop?: { isDesktop?: boolean };
  };

  return desktopWindow.hushDesktop?.isDesktop === true
    || window.location.protocol === "app:";
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Takes the shared presence lock for this page's lifetime. Resolves true once
 * it is granted, false when the request fails. Safe to call more than once.
 */
function holdPresenceLock(locks: LockManager): Promise<boolean> {
  if (presence) return presence;
  presence = new Promise<boolean>((resolve) => {
    try {
      locks
        .request(TAB_PRESENCE_LOCK, { mode: "shared" }, () => {
          resolve(true);
          return new Promise<never>(() => {});
        })
        .catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
  return presence;
}

/** True only when the lock list shows no other open Space page. */
async function isOnlySpacePage(locks: LockManager): Promise<boolean> {
  try {
    const { held = [], pending = [] } = await locks.query();
    const presenceCount = (list: readonly LockInfo[]) =>
      list.filter((lock) => lock.name === TAB_PRESENCE_LOCK).length;
    return presenceCount(held) === 1 && presenceCount(pending) === 0;
  } catch {
    return false;
  }
}

function readQuietUpdateAt(): number {
  try {
    const raw = window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** Returns false when the timestamp cannot be kept (so no loop guard). */
function writeQuietUpdateAt(at: number): boolean {
  try {
    window.sessionStorage.setItem(QUIET_UPDATE_STORAGE_KEY, String(at));
    return window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY) === String(at);
  } catch {
    return false;
  }
}

/** Resolves when the new worker takes control, or after `ms` regardless. */
function waitForNewController(container: ServiceWorkerContainer, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    container.addEventListener("controllerchange", done);
  });
}

type Decision =
  | { outcome: Exclude<QuietUpdateOutcome, "applied" | "post-failed" | "error"> }
  | { outcome: "applied"; waiting: ServiceWorker; container: ServiceWorkerContainer };

async function decideAtStart(): Promise<Decision> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return { outcome: "unsupported" };
  if (isDesktopRenderer()) return { outcome: "unsupported" };
  const container = navigator.serviceWorker;

  // Every booting page announces itself at once, whatever happens next.
  const locks = navigator.locks;
  const hasLocks = typeof locks?.request === "function" && typeof locks?.query === "function";
  const granted = hasLocks ? holdPresenceLock(locks) : Promise.resolve(false);

  const registration = typeof container?.getRegistration === "function"
    ? await withTimeout(container.getRegistration(), QUIET_UPDATE_STEP_TIMEOUT_MS, undefined)
    : undefined;
  if (!registration) return { outcome: "no-registration" };
  const waiting = registration.waiting;
  if (!waiting) return { outcome: "none-waiting" };
  if (!container.controller) return { outcome: "uncontrolled" };

  if (!hasLocks) return { outcome: "no-locks" };
  if (!(await withTimeout(granted, QUIET_UPDATE_STEP_TIMEOUT_MS, false))) return { outcome: "lock-late" };
  if (!(await isOnlySpacePage(locks))) return { outcome: "other-pages" };

  const now = Date.now();
  const last = readQuietUpdateAt();
  if (last > 0 && last <= now && now - last < QUIET_UPDATE_RETRY_MS) return { outcome: "recent" };
  if (!writeQuietUpdateAt(now)) return { outcome: "no-storage" };
  return { outcome: "applied", waiting, container };
}

/**
 * Called first in boot(). Activates a waiting newer build and reloads into it
 * when that interrupts nobody (see the file comment). Resolves "applied" when
 * the page is reloading, in which case boot must stop; any other outcome means
 * boot carries on with the current build.
 */
export async function applyWaitingBuildAtStart(options: QuietUpdateOptions = {}): Promise<QuietUpdateOutcome> {
  const reload = options.reload ?? (() => window.location.reload());
  // Never rejects: boot must carry on whatever goes wrong here.
  let decision: Decision | null = null;
  let outcome: QuietUpdateOutcome;
  try {
    decision = await decideAtStart();
    outcome = decision.outcome;
  } catch {
    outcome = "error";
  }

  if (decision?.outcome === "applied") {
    try {
      // The generated worker answers this message with self.skipWaiting().
      decision.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch {
      outcome = "post-failed";
    }
  }

  try {
    recordClientDiagnostic({
      category: "update",
      event: "sw-boot-update",
      severity: "info",
      details: { outcome },
    });
  } catch {
    // Diagnostics never block boot.
  }

  if (outcome === "applied" && decision?.outcome === "applied") {
    await waitForNewController(decision.container, QUIET_UPDATE_ACTIVATE_TIMEOUT_MS);
    reload();
  }
  return outcome;
}
