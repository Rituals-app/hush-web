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
// It does not reload a running page either: this page keeps its current,
// compatible build. The newer build is applied at the start of a later page
// load, before any app module runs, by src/lib/quietUpdate.ts (called first in
// src/main.jsx), or by the browser once every page using the old SW has closed.
//
// The PWA layer is the ONLY place that touches the SW lifecycle. It does NOT
// read or write IndexedDB, localStorage, MLS state, vault state, or any
// authentication material.

import { setWaitingUpdateSW } from "./updateRequired";
import { registerSW } from "virtual:pwa-register";
import { recordClientDiagnostic } from "./clientDiagnostics";
import { isDesktopRenderer } from "./quietUpdate";

/**
 * Register the Service Worker via vite-plugin-pwa. Idempotent — calling it
 * twice is safe; the plugin internally guards re-registration.
 *
 * In environments where the SW is unavailable (vitest, SSR, browsers without
 * SW support) this is a no-op.
 */
let hasRegistered = false;

export function registerPWA(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (isDesktopRenderer()) return;
  if (hasRegistered) return;

  try {
    hasRegistered = true;
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Stash the activator so an Update Required dialog (raised for a real
        // incompatibility) loads the new build when clicked. Nothing else
        // happens now: the next page load applies it (src/lib/quietUpdate.ts).
        setWaitingUpdateSW(async () => {
          await updateSW(true);
        });
        recordClientDiagnostic({
          category: "update",
          event: "sw-need-refresh",
          severity: "info",
          details: { outcome: "kept-for-next-load" },
        });
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
