// Rituals fork (2026-11-06): a running page that fails to load part of its
// build. After a release the host serves the newer build, so a page still
// running the old one can ask for a file the host no longer has (lazy
// screens and their stylesheets are not precached by the Service Worker).
// When a newer build has taken over or is ready, the Update dialog offers it
// (reason "chunk-load-failed"); src/components/ChunkErrorBoundary.jsx keeps
// a screen that failed to load from blanking the app. Boot itself recovers in
// src/main.jsx.

import { markChunkLoadError } from "./chunkErrors";
import { findNewerBuild, skipWaitingNow } from "./quietUpdate";
import { getWaitingUpdateSW, requestUpdate, setWaitingUpdateSW } from "./updateRequired";

let offer: Promise<boolean> | null = null;
let installed = false;

/**
 * Raises the Update dialog when a build newer than this page's has taken over
 * or is ready, waiting briefly for one that is still installing. Resolves
 * whether it did. Concurrent calls share one check; a check that found nothing
 * can run again.
 */
export function offerNewerBuild(): Promise<boolean> {
  if (offer) return offer;
  const check = findNewerBuild().then((found) => {
    if (!found) {
      offer = null;
      return false;
    }
    // The PWA layer stores its own activator once it reports the waiting
    // build; until then the dialog's Update activates it directly.
    if (!getWaitingUpdateSW()) {
      setWaitingUpdateSW(async () => {
        await skipWaitingNow();
      });
    }
    requestUpdate({ reason: "chunk-load-failed" });
    return true;
  });
  offer = check;
  return check;
}

/**
 * Listens for Vite's report of a chunk that failed to load. The error still
 * reaches the code that asked for the chunk (React.lazy, an await import()).
 * Safe to call more than once.
 */
export function installChunkRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("vite:preloadError", (event) => {
    markChunkLoadError((event as Event & { payload?: unknown }).payload);
    void offerNewerBuild();
  });
}
