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
// Now:
//   * If the person has not touched the page yet (no pointer, touch or key
//     input since load), the update is applied at once. That is a reload, the
//     same one the dialog's Update button did, so nobody is interrupted.
//   * Otherwise nothing interrupts them. This page keeps running its current,
//     compatible build, and the waiting SW is applied on the next load.
//   * A reload loop is impossible: one quiet apply per tab session every
//     QUIET_UPDATE_RETRY_MS.
//
// The PWA layer is the ONLY place that touches the SW lifecycle. It does NOT
// read or write IndexedDB, localStorage, MLS state, vault state, or any
// authentication material. It keeps one timestamp in sessionStorage (the loop
// guard below).

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

const INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Register the Service Worker via vite-plugin-pwa. Idempotent — calling it
 * twice is safe; the plugin internally guards re-registration.
 *
 * In environments where the SW is unavailable (vitest, SSR, browsers without
 * SW support) this is a no-op.
 */
let hasRegistered = false;
let hasInteracted = false;
let stopWatchingInteraction: (() => void) | null = null;

function isDesktopRenderer(): boolean {
  if (typeof window === "undefined") return false;

  const desktopWindow = window as typeof window & {
    hushDesktop?: { isDesktop?: boolean };
  };

  return desktopWindow.hushDesktop?.isDesktop === true
    || window.location.protocol === "app:";
}

/** Remember the first pointer, touch or key input on this page. */
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

/**
 * Called when a newer SW is installed and waiting. Applies it now when that
 * interrupts nobody, otherwise leaves it for the next load.
 */
function handleWaitingServiceWorker(): void {
  const now = Date.now();
  let outcome: "applied" | "deferred-interacted" | "deferred-recent" | "deferred-no-storage";
  if (hasInteracted) {
    outcome = "deferred-interacted";
  } else {
    const last = readQuietUpdateAt();
    if (last > 0 && last <= now && now - last < QUIET_UPDATE_RETRY_MS) {
      outcome = "deferred-recent";
    } else if (!writeQuietUpdateAt(now)) {
      outcome = "deferred-no-storage";
    } else {
      outcome = "applied";
    }
  }

  recordClientDiagnostic({
    category: "update",
    event: "sw-need-refresh",
    severity: "info",
    details: { outcome },
  });

  if (outcome === "applied") {
    stopWatchingInteraction?.();
    void applyUpdate();
  }
}

export function registerPWA(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (isDesktopRenderer()) return;
  if (hasRegistered) return;

  try {
    hasRegistered = true;
    watchFirstInteraction();
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Stash the activator so an Update Required dialog (raised for a real
        // incompatibility) loads the new build when clicked.
        setWaitingUpdateSW(async () => {
          await updateSW(true);
        });
        handleWaitingServiceWorker();
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
