// Rituals fork (2026-11-06): tells a failed load of one of this build's files
// (a JavaScript chunk or its stylesheet) apart from other errors. After a
// release, a page still running the old build asks for files of that build;
// see src/lib/chunkRecovery.ts. Imports nothing: src/main.jsx uses it before
// the app loads.
//
// Only the message counts. Vite's `vite:preloadError` event is no proof: it
// also carries an error a chunk threw while it ran, which a newer build does
// not fix and must reach the next error boundary unchanged.

// Chrome, Firefox and Safari word a failed dynamic import differently; Vite
// words a failed stylesheet preload.
const CHUNK_LOAD_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** True when `error` says one of this build's files did not load. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return CHUNK_LOAD_ERROR.test(message);
}
