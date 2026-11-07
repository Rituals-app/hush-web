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
//   * the host answers. The newer build's main files are not in the precache,
//     so reloading into it without a connection ends on the retry notice in
//     src/main.jsx. canReachHost() asks only when a build is waiting, so other
//     boots pay nothing. A page whose build failed to load gives a slow host
//     longer, since it has nothing else to run;
//   * a reload loop is impossible: at most one attempt per tab every
//     QUIET_UPDATE_RETRY_MS, and none when that guard cannot be stored.
// Otherwise the page boots its current, compatible build. The waiting worker
// takes over once every page using the old one has closed, or at a later
// boot that finds this page alone with the host in reach.
//
// Two cases reload without the alone check, because this page is already
// broken and its old build can no longer load:
//   * "taken-over": another page activated the newer build while this one was
//     still booting, so the worker that serves this page is no longer the one
//     its build came from (controllerChangedSinceBoot, also checked by
//     src/main.jsx right before the app module loads);
//   * part of this build failed to load after a release (src/main.jsx and
//     src/lib/chunkRecovery.ts). That path waits for a newer build that is
//     still installing (awaitInstall, findNewerBuild) and asks the person
//     before activating it while other Space pages are open.
// Both still respect the once-per-QUIET_UPDATE_RETRY_MS guard.
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

/** How long a page whose build failed to load waits for a newer build to finish installing. */
export const QUIET_UPDATE_INSTALL_TIMEOUT_MS = 15_000;

/** How long boot waits for the host to answer before leaving a waiting build for later. */
export const QUIET_UPDATE_PROBE_TIMEOUT_MS = 1_500;

/**
 * The same wait for a page whose build failed to load. It has nothing else to
 * run, and "offline" leaves it on the notice in src/main.jsx telling the person
 * to check their connection, so a slow host is worth waiting for. With the
 * install wait, the longest time behind that notice stays about 20 s.
 */
export const QUIET_UPDATE_FAILED_LOAD_PROBE_TIMEOUT_MS = 5_000;

export type QuietUpdateOutcome =
  | "applied"
  | "taken-over"
  | "unsupported"
  | "no-registration"
  | "none-waiting"
  | "uncontrolled"
  | "offline"
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
  /**
   * Also waits, up to QUIET_UPDATE_INSTALL_TIMEOUT_MS, for a newer build that
   * is still installing. Only for a page whose build failed to load.
   */
  awaitInstall?: boolean;
}

let presence: Promise<boolean> | null = null;

// Boot runs before the diagnostic log listens (src/appMain.jsx starts it), so
// outcomes wait here until flushBootUpdateDiagnostics(); null once flushed.
let pendingOutcomes: QuietUpdateOutcome[] | null = [];

function currentController(): ServiceWorker | null {
  try {
    return typeof navigator === "undefined" ? null : navigator.serviceWorker?.controller ?? null;
  } catch {
    return null;
  }
}

// The worker that controlled this page when boot began: src/main.jsx imports
// this module before anything else runs.
const bootController = currentController();

/** The Electron desktop renderer never registers the Service Worker. */
export function isDesktopRenderer(): boolean {
  if (typeof window === "undefined") return false;

  const desktopWindow = window as typeof window & {
    hushDesktop?: { isDesktop?: boolean };
  };

  return desktopWindow.hushDesktop?.isDesktop === true
    || window.location.protocol === "app:";
}

function hasServiceWorkers(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && !isDesktopRenderer();
}

/**
 * True once another worker has taken control of this page since boot began:
 * another Space page activated a newer build, so the worker serving this page
 * no longer holds this build's files.
 */
export function controllerChangedSinceBoot(): boolean {
  if (isDesktopRenderer()) return false;
  const current = currentController();
  return bootController !== null && current !== null && current !== bootController;
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
    const snapshot = await withTimeout(locks.query(), QUIET_UPDATE_STEP_TIMEOUT_MS, null);
    if (!snapshot) return false;
    const { held = [], pending = [] } = snapshot;
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
interface ControllerWait {
  /** Resolves on the next controllerchange, or after the timeout. */
  tookControl: Promise<void>;
  /** Stops listening and resolves tookControl at once. */
  stop: () => void;
}

/** Starts listening at once, so a takeover right after a post is not missed. */
function listenForNewController(container: ServiceWorkerContainer, ms: number): ControllerWait {
  let stop = () => {};
  const tookControl = new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    container.addEventListener("controllerchange", done);
    stop = done;
  });
  return { tookControl, stop };
}

function waitForNewController(container: ServiceWorkerContainer, ms: number): Promise<void> {
  return listenForNewController(container, ms).tookControl;
}

type RetryClaim = "claimed" | "recent" | "no-storage";

/** Takes this tab's one update attempt per QUIET_UPDATE_RETRY_MS. */
function claimRetryWindow(): RetryClaim {
  const now = Date.now();
  const last = readQuietUpdateAt();
  if (last > 0 && last <= now && now - last < QUIET_UPDATE_RETRY_MS) return "recent";
  return writeQuietUpdateAt(now) ? "claimed" : "no-storage";
}

function findRegistration(container: ServiceWorkerContainer): Promise<ServiceWorkerRegistration | undefined> {
  return typeof container?.getRegistration === "function"
    ? withTimeout(container.getRegistration(), QUIET_UPDATE_STEP_TIMEOUT_MS, undefined)
    : Promise.resolve(undefined);
}

/**
 * Resolves the waiting worker once a newer build has finished installing, or
 * null when none is found within `ms`. Asks the browser to check for one when
 * nothing is installing yet. Never rejects.
 */
function waitForInstalledBuild(registration: ServiceWorkerRegistration, ms: number): Promise<ServiceWorker | null> {
  if (registration.waiting) return Promise.resolve(registration.waiting);
  return new Promise((resolve) => {
    let settled = false;
    let watched: ServiceWorker | null = null;
    const onState = () => {
      if (watched && watched.state !== "parsed" && watched.state !== "installing") finish();
    };
    const watch = () => {
      const installing = registration.installing;
      if (!installing || installing === watched) return;
      watched?.removeEventListener("statechange", onState);
      watched = installing;
      installing.addEventListener("statechange", onState);
      onState();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      registration.removeEventListener?.("updatefound", watch);
      watched?.removeEventListener("statechange", onState);
      let waiting: ServiceWorker | null;
      try {
        waiting = registration.waiting ?? null;
      } catch {
        waiting = null;
      }
      resolve(waiting);
    };
    const timer = setTimeout(finish, ms);
    try {
      registration.addEventListener?.("updatefound", watch);
      watch();
      if (!watched && typeof registration.update === "function") {
        // update() resolves once a newer script is installing, or with nothing to install.
        registration.update().then(() => {
          watch();
          if (!watched) finish();
        }, finish);
      }
    } catch {
      finish();
    }
  });
}

/**
 * Whether the host answers now. sw.js is not in the precache and is not a
 * navigation, so the worker passes this request to the network; it is the one
 * file the host must serve for any update to exist. A redirect off this origin
 * (a captive portal) or any error answer counts as no.
 */
async function canReachHost(limitMs: number): Promise<boolean> {
  if (navigator.onLine === false) return false;
  const request = new AbortController();
  try {
    const answer = fetch("/sw.js", { cache: "no-store", mode: "same-origin", signal: request.signal })
      .then((response) => response.ok);
    return await withTimeout(answer, limitMs, false);
  } catch {
    return false;
  } finally {
    // Nothing reads the body.
    request.abort();
  }
}

type Decision =
  | { outcome: Exclude<QuietUpdateOutcome, "applied" | "post-failed" | "error"> }
  | { outcome: "applied"; waiting: ServiceWorker; container: ServiceWorkerContainer };

/** This page's build lost its worker to a newer one: reload into it, once per window. */
function takenOver(): Decision {
  const claim = claimRetryWindow();
  return { outcome: claim === "claimed" ? "taken-over" : claim };
}

async function decideAtStart(options: QuietUpdateOptions): Promise<Decision> {
  if (!hasServiceWorkers()) return { outcome: "unsupported" };
  const container = navigator.serviceWorker;

  // Every booting page announces itself at once, whatever happens next.
  const locks = navigator.locks;
  const hasLocks = typeof locks?.request === "function" && typeof locks?.query === "function";
  const granted = hasLocks ? holdPresenceLock(locks) : Promise.resolve(false);

  if (controllerChangedSinceBoot()) return takenOver();
  const registration = await findRegistration(container);
  if (!registration) return { outcome: "no-registration" };
  const waiting = registration.waiting
    ?? (options.awaitInstall ? await waitForInstalledBuild(registration, QUIET_UPDATE_INSTALL_TIMEOUT_MS) : null);
  // Another page may have activated the newer build meanwhile.
  if (controllerChangedSinceBoot()) return takenOver();
  if (!waiting) return { outcome: "none-waiting" };
  if (!container.controller) return { outcome: "uncontrolled" };
  // The worker stays waiting and the retry window stays unclaimed, so a later
  // start applies it. It also comes before the outcomes that offer Update: a
  // build that cannot load is not worth offering.
  const reachable = await canReachHost(
    options.awaitInstall ? QUIET_UPDATE_FAILED_LOAD_PROBE_TIMEOUT_MS : QUIET_UPDATE_PROBE_TIMEOUT_MS,
  );
  // Another page may have activated the newer build during the check. The
  // reload that takes this page there does not depend on the answer.
  if (controllerChangedSinceBoot()) return takenOver();
  if (!reachable) return { outcome: "offline" };

  if (!hasLocks) return { outcome: "no-locks" };
  if (!(await withTimeout(granted, QUIET_UPDATE_STEP_TIMEOUT_MS, false))) return { outcome: "lock-late" };
  if (!(await isOnlySpacePage(locks))) return { outcome: "other-pages" };

  const claim = claimRetryWindow();
  if (claim !== "claimed") return { outcome: claim };
  return { outcome: "applied", waiting, container };
}

function recordOutcome(outcome: QuietUpdateOutcome): void {
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
}

/**
 * Records the boot outcomes kept so far and every later one at once. Called by
 * src/appMain.jsx once the diagnostic log listens. An outcome that reloads the
 * page is lost with it.
 */
export function flushBootUpdateDiagnostics(): void {
  const outcomes = pendingOutcomes ?? [];
  pendingOutcomes = null;
  outcomes.forEach(recordOutcome);
}

/**
 * Called first in boot(). Activates a waiting newer build and reloads into it
 * when that interrupts nobody (see the file comment). Resolves "applied" or
 * "taken-over" when the page is reloading, in which case boot must stop; any
 * other outcome means boot carries on with the current build.
 */
export async function applyWaitingBuildAtStart(options: QuietUpdateOptions = {}): Promise<QuietUpdateOutcome> {
  const reload = options.reload ?? (() => window.location.reload());
  // Never rejects: boot must carry on whatever goes wrong here.
  let decision: Decision | null = null;
  let outcome: QuietUpdateOutcome;
  try {
    decision = await decideAtStart(options);
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

  if (pendingOutcomes) pendingOutcomes.push(outcome);
  else recordOutcome(outcome);

  if (outcome === "applied" && decision?.outcome === "applied") {
    await waitForNewController(decision.container, QUIET_UPDATE_ACTIVATE_TIMEOUT_MS);
    reload();
  } else if (outcome === "taken-over") {
    reload();
  }
  return outcome;
}

/**
 * Whether a build newer than this page's has taken over or is ready, waiting
 * up to QUIET_UPDATE_INSTALL_TIMEOUT_MS for one that is still installing. For
 * a page that failed to load part of its build (src/lib/chunkRecovery.ts).
 * Never rejects.
 */
export async function findNewerBuild(): Promise<boolean> {
  try {
    if (!hasServiceWorkers()) return false;
    if (controllerChangedSinceBoot()) return true;
    const registration = await findRegistration(navigator.serviceWorker);
    if (!registration) return false;
    return (await waitForInstalledBuild(registration, QUIET_UPDATE_INSTALL_TIMEOUT_MS)) !== null;
  } catch {
    return false;
  }
}

/**
 * Tells a waiting newer build to take over now, which switches every open
 * Space page to it. Only after the person asked to update. Resolves false
 * when nothing is waiting. Never rejects.
 */
export async function skipWaitingNow(): Promise<boolean> {
  try {
    if (!hasServiceWorkers()) return false;
    const waiting = (await findRegistration(navigator.serviceWorker))?.waiting;
    if (!waiting) return false;
    waiting.postMessage({ type: "SKIP_WAITING" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The person asked to update: activates the waiting build, if any, waits for
 * it to take control (at most QUIET_UPDATE_ACTIVATE_TIMEOUT_MS) and reloads.
 */
export async function activateWaitingBuild(options: Pick<QuietUpdateOptions, "reload"> = {}): Promise<void> {
  const reload = options.reload ?? (() => window.location.reload());
  // Listening starts before the post: the takeover can land before
  // skipWaitingNow() resolves.
  const wait = hasServiceWorkers()
    ? listenForNewController(navigator.serviceWorker, QUIET_UPDATE_ACTIVATE_TIMEOUT_MS)
    : null;
  if (wait && (await skipWaitingNow())) await wait.tookControl;
  wait?.stop();
  reload();
}
