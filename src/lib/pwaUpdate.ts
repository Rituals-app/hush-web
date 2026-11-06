// Service Worker registration shim.
//
// vite-plugin-pwa generates the virtual module `virtual:pwa-register` at
// build time. Vitest resolves it through a test-only alias in vitest.config.js
// so the production import stays static and Vite can bundle it correctly.
//
// Side effects: when invoked, this function asks the browser to register the
// SW. When the plugin reports `onNeedRefresh`, we stash the updater callback in
// the global update-required store, so any Update Required dialog activates the
// new SW on click.
//
// Rituals fork (2026-11-06): a waiting SW only means a newer build of the
// Space exists. It is not an incompatibility: the server says so separately
// (handshake min_compatible_client_version, the MLS ciphersuite, a 426), and
// those still raise the blocking Update Required dialog. So `onNeedRefresh`
// no longer raises that dialog. Before, every returning person met a
// non-dismissible "A critical update is required" card after every release.
// Now the waiting build is applied quietly (a reload, the same one the
// dialog's Update button did) only when that interrupts nobody:
//   * nobody has used this page yet (no pointer, touch, key or wheel input);
//   * the page is hidden, or the page loaded moments ago
//     (QUIET_UPDATE_WINDOW_MS), so nobody is reading it yet;
//   * this is the only open Space page. Activating the new SW switches every
//     page that shares it, and the plugin reloads each one, so a quiet apply
//     in an untouched tab would reload a tab someone is using (a call, a
//     draft). Each page holds a shared Web Lock (TAB_PRESENCE_LOCK) for its
//     lifetime, and the lock list tells a page whether it is alone. Without
//     the Web Locks API nothing is applied quietly.
//   * a reload loop is impossible: one quiet apply per tab session every
//     QUIET_UPDATE_RETRY_MS, and none when that guard cannot be stored.
// Otherwise nothing interrupts anyone: this page keeps running its current,
// compatible build, and the waiting SW is applied on a later load.
//
// The PWA layer is the ONLY place that touches the SW lifecycle. It does NOT
// read or write IndexedDB, localStorage, MLS state, vault state, or any
// authentication material. It keeps one timestamp in sessionStorage (the loop
// guard) and holds one shared Web Lock that guards nothing.

import {
  applyUpdate,
  setWaitingUpdateSW,
} from "./updateRequired";
import { registerSW } from "virtual:pwa-register";
import { recordClientDiagnostic } from "./clientDiagnostics";

/** sessionStorage key holding when this tab last applied an update quietly. */
export const QUIET_UPDATE_STORAGE_KEY = "hush_sw_quiet_update_at";

/** A tab applies at most one quiet update in this window. */
export const QUIET_UPDATE_RETRY_MS = 2 * 60 * 1000;

/**
 * A visible page applies quietly only this soon after registration. A build
 * that was already waiting is reported within about a second; one that
 * downloads later waits for a later load rather than reloading a page
 * someone may be reading.
 */
export const QUIET_UPDATE_WINDOW_MS = 5_000;

/** Shared Web Lock every open Space page holds, so a page can tell if it is alone. */
export const TAB_PRESENCE_LOCK = "hush_sw_page_presence";

const INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

type QuietUpdateOutcome =
  | "applied"
  | "deferred-interacted"
  | "deferred-late"
  | "deferred-other-pages"
  | "deferred-recent"
  | "deferred-no-storage";

/**
 * Register the Service Worker via vite-plugin-pwa. Idempotent — calling it
 * twice is safe; the plugin internally guards re-registration.
 *
 * In environments where the SW is unavailable (vitest, SSR, browsers without
 * SW support) this is a no-op.
 */
let hasRegistered = false;
let registeredAt = 0;
let hasInteracted = false;
let holdsPresenceLock = false;
let stopWatchingInteraction: (() => void) | null = null;

function isDesktopRenderer(): boolean {
  if (typeof window === "undefined") return false;

  const desktopWindow = window as typeof window & {
    hushDesktop?: { isDesktop?: boolean };
  };

  return desktopWindow.hushDesktop?.isDesktop === true
    || window.location.protocol === "app:";
}

/** Remember the first pointer, touch, key or wheel input on this page. */
function watchFirstInteraction(): void {
  if (stopWatchingInteraction) return;
  const mark = () => {
    hasInteracted = true;
    stopWatchingInteraction?.();
  };
  const options = { capture: true, passive: true } as const;
  for (const type of INTERACTION_EVENTS) {
    window.addEventListener(type, mark, options);
  }
  stopWatchingInteraction = () => {
    for (const type of INTERACTION_EVENTS) {
      window.removeEventListener(type, mark, options);
    }
  };
}

/** Hold the shared presence lock until this page goes away. */
function holdPresenceLock(): void {
  const locks = navigator.locks;
  if (typeof locks?.request !== "function") return;
  try {
    locks
      .request(TAB_PRESENCE_LOCK, { mode: "shared" }, () => {
        holdsPresenceLock = true;
        return new Promise<never>(() => {});
      })
      .catch(() => {
        holdsPresenceLock = false;
      });
  } catch {
    holdsPresenceLock = false;
  }
}

/** True only when the lock list shows no other open Space page. */
async function isOnlySpacePage(): Promise<boolean> {
  const locks = navigator.locks;
  if (!holdsPresenceLock || typeof locks?.query !== "function") return false;
  try {
    const { held = [], pending = [] } = await locks.query();
    const presence = (list: readonly LockInfo[]) =>
      list.filter((lock) => lock.name === TAB_PRESENCE_LOCK).length;
    return presence(held) === 1 && presence(pending) === 0;
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

async function decideQuietUpdate(): Promise<QuietUpdateOutcome> {
  if (hasInteracted) return "deferred-interacted";
  const now = Date.now();
  const hidden = document.visibilityState === "hidden";
  if (!hidden && now - registeredAt > QUIET_UPDATE_WINDOW_MS) return "deferred-late";
  if (!(await isOnlySpacePage())) return "deferred-other-pages";
  // Input may have arrived while the lock list was read.
  if (hasInteracted) return "deferred-interacted";
  const last = readQuietUpdateAt();
  if (last > 0 && last <= now && now - last < QUIET_UPDATE_RETRY_MS) return "deferred-recent";
  if (!writeQuietUpdateAt(now)) return "deferred-no-storage";
  return "applied";
}

/**
 * applyUpdate reloads at once when the new SW takes control, or after a few
 * seconds when it never does (a page no SW controls). That late reload must
 * not land on someone who has started using the page meanwhile.
 */
function reloadUnlessInteracted(): void {
  if (hasInteracted) {
    recordClientDiagnostic({
      category: "update",
      event: "sw-quiet-reload-skipped",
      severity: "info",
      details: { reason: "interacted" },
    });
    return;
  }
  window.location.reload();
}

/**
 * Called when a newer SW is installed and waiting. Applies it now when that
 * interrupts nobody, otherwise leaves it for a later load.
 */
async function handleWaitingServiceWorker(): Promise<void> {
  const outcome = await decideQuietUpdate();

  recordClientDiagnostic({
    category: "update",
    event: "sw-need-refresh",
    severity: "info",
    details: { outcome },
  });

  if (outcome === "applied") {
    await applyUpdate({ location: { reload: reloadUnlessInteracted } });
  }
}

export function registerPWA(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (isDesktopRenderer()) return;
  if (hasRegistered) return;

  try {
    hasRegistered = true;
    registeredAt = Date.now();
    watchFirstInteraction();
    holdPresenceLock();
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Stash the activator so an Update Required dialog (raised for a real
        // incompatibility) loads the new build when clicked.
        setWaitingUpdateSW(async () => {
          await updateSW(true);
        });
        void handleWaitingServiceWorker();
      },
      onRegisterError(err: unknown) {
        // SW registration failure is non-fatal for the app. Log and move on.
        recordClientDiagnostic({
          category: "update",
          event: "sw-register-failed",
          severity: "warn",
          details: { message: err instanceof Error ? err.message : String(err) },
        });
        // eslint-disable-next-line no-console
        console.warn("[pwa] registration failed", err);
      },
    } as never);
  } catch (err) {
    hasRegistered = false;
    // Registration failure is non-fatal for the app.
    // eslint-disable-next-line no-console
    console.warn("[pwa] registration failed", err);
  }
}
