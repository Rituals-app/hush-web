// Rituals fork (2026-11-06): a running page that fails to load part of its
// build. After a release the host serves the newer build, so a page still
// running the old one can ask for a file the host no longer has (lazy
// screens and their stylesheets are not precached by the Service Worker).
// When a newer build has taken over or is ready, the Update dialog offers it
// (reason "chunk-load-failed"); the person may put it off, since the failed
// file can be optional or the network briefly gone. src/components/
// ChunkErrorBoundary.jsx keeps a screen that failed to load from blanking the
// app. Boot itself recovers in src/main.jsx.

import { isChunkLoadError } from "./chunkErrors";
import { controllerChangedSinceBoot, findNewerBuild, skipWaitingNow } from "./quietUpdate";
import { getWaitingUpdateSW, requestUpdate, setWaitingUpdateSW } from "./updateRequired";

let check: Promise<boolean> | null = null;
let found = false;
let installed = false;

function raise(): void {
  // The PWA layer stores its own activator once it reports the waiting
  // build; until then the dialog's Update activates it directly. Resolving
  // false (nothing left waiting: another page already activated it) makes
  // applyUpdate reload at once.
  if (!getWaitingUpdateSW()) {
    setWaitingUpdateSW(() => (controllerChangedSinceBoot() ? Promise.resolve(false) : skipWaitingNow()));
  }
  requestUpdate({ reason: "chunk-load-failed" });
}

/**
 * Raises the Update dialog when a build newer than this page's has taken over
 * or is ready, waiting briefly for one that is still installing. Resolves
 * whether it did. Concurrent calls share one check; a check that found
 * nothing can run again. Once a newer build is known, every later call
 * raises the dialog again at once (it stays one dialog while it is open), so
 * a failure after the person chose Later offers it again.
 */
export function offerNewerBuild(): Promise<boolean> {
  if (found) {
    raise();
    return Promise.resolve(true);
  }
  if (check) return check;
  const pending = findNewerBuild().then((isNewer) => {
    check = null;
    if (!isNewer) return false;
    found = true;
    raise();
    return true;
  });
  check = pending;
  return pending;
}

/**
 * Listens for Vite's report of a chunk that failed to load. The error still
 * reaches the code that asked for the chunk (React.lazy, an await import()).
 * The same event carries an error a chunk threw while it ran: that is no
 * missing file, so it offers nothing. Safe to call more than once.
 */
export function installChunkRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("vite:preloadError", (event) => {
    if (isChunkLoadError((event as Event & { payload?: unknown }).payload)) void offerNewerBuild();
  });
}
