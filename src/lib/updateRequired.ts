// Global "Update Required" event bridge + store for the Hush web client.
//
// Why an event bridge: the trigger sources are scattered (PWA SW lifecycle,
// boot-time handshake checks, runtime API responses). Tying them into a
// single global state object means a top-level `<UpdateRequiredDialog />`
// component can render the moment any of them fires, without each subsystem
// needing a direct prop path into the React tree.
//
// What this module does NOT do:
//   * It never touches localStorage, IndexedDB, MLS state, the vault, or any
//     long-term cryptographic key material. The dialog's Update action is
//     responsible for the actual reload; this file only signals "show me".
//   * It never reads cookies or session data.
//
// Web Push and Background Sync are explicit non-goals (separate threat models
// required) — see prompt and src/lib/pwaWorkboxOptions.js.

/**
 * Reason codes for surfacing the Update Required dialog. Used for telemetry
 * and to keep tests legible; the UI copy is generic and reason-agnostic.
 */
export type UpdateRequiredReason =
  | "sw-need-refresh" // a newer SW is waiting (the Rituals fork no longer raises this: see pwaUpdate.ts)
  | "min-client-version" // handshake.min_client_version > local app version
  | "ciphersuite-mismatch" // handshake.current_mls_ciphersuite !== client constant
  | "api-426" // server replied 426 Upgrade Required
  | "api-mls-ciphersuite-mismatch" // server replied with mls_ciphersuite_mismatch error
  | "api-compat-error"; // generic compatibility error from server (extension hook)

export interface UpdateRequiredDetail {
  /** Reason the dialog was raised. */
  reason: UpdateRequiredReason;
  /** Free-form context for diagnostics; never shown to the user. */
  context?: Record<string, unknown>;
}

/**
 * DOM event name. Consumers (api.js, useInstances.js, the dialog) all use
 * the same string — change in lockstep.
 */
export const UPDATE_REQUIRED_EVENT = "hush:update-required";

/**
 * Holder for an in-memory "SW update is waiting" callback. The PWA layer
 * (src/lib/pwaUpdate.js) registers a function here that, when invoked,
 * activates the waiting SW (via the vite-plugin-pwa updateSW(true) call).
 *
 * Stored in module scope rather than React state because:
 *   1. The dialog must work even before React mounts (boot failure path).
 *   2. The callback is set once per session by the SW register and is
 *      reused for every Update click.
 */
let waitingUpdateSW: (() => Promise<void>) | null = null;

/**
 * Set the function that activates the waiting Service Worker. Called by
 * src/lib/pwaUpdate.js after vite-plugin-pwa reports `needRefresh`.
 *
 * Pass null to clear (test cleanup).
 */
export function setWaitingUpdateSW(fn: (() => Promise<void>) | null): void {
  waitingUpdateSW = fn;
}

/**
 * Returns the currently registered SW updater, or null when no SW is
 * waiting. Exposed for the dialog action and tests.
 */
export function getWaitingUpdateSW(): (() => Promise<void>) | null {
  return waitingUpdateSW;
}

/**
 * Dispatch a global Update Required event. Safe to call before React mounts
 * and from any module (api.js, useInstances.js, the PWA register hook).
 *
 * Idempotent at the event level: the dialog state hook deduplicates.
 */
export function requestUpdate(detail: UpdateRequiredDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<UpdateRequiredDetail>(UPDATE_REQUIRED_EVENT, { detail }),
  );
}

/**
 * Apply the update.
 *
 * Order of preference:
 *   1. If a waiting SW updater is registered, call it. It resolves once
 *      `skipWaiting` has been acknowledged. We then wait for the SW
 *      `controllerchange` event (or a short timeout) before reloading so
 *      the new bundle is the one served to the next navigation.
 *   2. Otherwise fall back to a plain reload. Cache cleanup is owned by
 *      Workbox on SW activation; this module never loops over Cache API
 *      entries and never touches IndexedDB or localStorage.
 *
 * Returns a promise that resolves when the reload has been initiated. In
 * production the page navigates before the promise actually resolves.
 *
 * Exposed for the dialog action and tests.
 */
export async function applyUpdate(
  opts: {
    location?: Pick<Location, "reload">;
    serviceWorker?: ServiceWorkerContainer;
    controllerChangeTimeoutMs?: number;
  } = {},
): Promise<void> {
  const loc =
    opts.location ?? (typeof window !== "undefined" ? window.location : null);
  const swContainer =
    opts.serviceWorker ??
    (typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : undefined);

  const reload = () => {
    try {
      loc?.reload();
    } catch {
      /* test environments may not implement reload */
    }
  };

  const updater = waitingUpdateSW;
  if (updater && swContainer) {
    // Activate the waiting SW. We rely on either `controllerchange` (fired
    // when the new SW takes over) or the updater promise itself to know
    // when to reload. A short timeout protects against pathological cases
    // where the SW never transitions.
    const timeoutMs = opts.controllerChangeTimeoutMs ?? 5_000;
    let reloaded = false;
    const safeReload = () => {
      if (reloaded) return;
      reloaded = true;
      reload();
    };

    const controllerChangePromise = new Promise<void>((resolve) => {
      const handler = () => {
        swContainer.removeEventListener?.("controllerchange", handler);
        resolve();
      };
      swContainer.addEventListener?.("controllerchange", handler);
    });

    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(resolve, timeoutMs),
    );

    try {
      await updater();
    } catch {
      // Even if the updater throws (e.g. SW already gone), continue to
      // the reload path — a fresh load fixes most stuck states.
    }
    await Promise.race([controllerChangePromise, timeoutPromise]);
    safeReload();
    return;
  }

  // Fallback path: no SW available. Reload only. Workbox owns Cache API
  // cleanup; the update action must not manually delete browser state.
  reload();
}
