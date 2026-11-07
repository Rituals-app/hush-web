// Workbox / vite-plugin-pwa configuration for the Hush PWA.
//
// Exported from a standalone module so vite.config.js consumes it for the build
// and the test runner can import the same object to assert on its shape (e.g.
// confirming that /api, /ws, /livekit, attachments, and external object-storage
// URLs are never runtime-cached).
//
// Design constraints (see prompt + CLAUDE.md):
//   * SW is conservative: precache the static app shell, nothing else.
//   * /api/*, /ws, /livekit/*, attachment endpoints, and any presigned /
//     external storage URL must never be served from the SW cache.
//   * /admin/* is a separate backend-served dashboard and must never receive
//     the user app shell as a navigation fallback.
//   * A controlled page's navigation is answered from the precached index.html
//     (the generated worker tries the precache, the navigation route, then the
//     runtime rules, and the first match wins), so that page runs its old build
//     first. A deployed update is found by the browser's check of sw.js and
//     applied by src/lib/quietUpdate.ts or the Update Required dialog.
//   * No IndexedDB, no localStorage, no auth/vault/MLS access from the SW.
//
// Web Push and Background Sync are out of scope for this PWA foundation:
//   - Web Push for E2EE notifications requires a separate threat model
//     (notification payload privacy, server-side identity correlation).
//   - Background Sync for sending messages/files needs an MLS/epoch/idempotency
//     threat model (a queued send could be replayed against a future epoch).
// Do not enable either inside this Service Worker without that review.

/**
 * URL patterns whose responses MUST bypass the Service Worker cache entirely.
 * Exported so tests can assert the SW config never accidentally caches them.
 */
export const NEVER_CACHE_URL_PATTERNS = Object.freeze([
  // Server API: every response is request-specific (auth-scoped, time-scoped,
  // or contains opaque encrypted blobs whose freshness matters).
  /\/api\//,
  // WebSocket upgrade endpoint - not cacheable by definition.
  /\/ws(\?|$)/,
  // LiveKit signaling/HTTP endpoints - real-time, never cached.
  /\/livekit\//,
  // Admin dashboard is served by hush-server, not by the user app bundle.
  /^\/admin(?:\/|$)/,
  // Attachment presign + download endpoints (server-relative paths).
  /\/api\/.*\/attachments\//,
  /\/api\/attachments\//,
  // Rituals fork: AGPL source tarballs served by the host edge at /source/.
  /^\/source(?:\/|$)/,
]);

/**
 * Build-time globs considered for the precache manifest. These are filtered by
 * `filterPrecacheManifest` below, because Vite emits many lazy chunks (syntax
 * highlighter grammars, route bundles, dev tools) that are static files but are
 * NOT part of the app shell.
 */
export const PRECACHE_GLOB_PATTERNS = Object.freeze([
  "**/*.{js,css,html,ico,png,svg,webp,woff,woff2,wasm}",
]);

/**
 * Patterns excluded from the precache manifest. Anything that should not be
 * shipped as part of the precached shell goes here.
 */
export const PRECACHE_GLOB_IGNORE = Object.freeze([
  // Source maps are dev artefacts even when emitted.
  "**/*.map",
  // Service worker itself never precaches itself.
  "sw.js",
  "workbox-*.js",
]);

/**
 * Exact app-shell allowlist for the generated precache manifest.
 *
 * This keeps the SW cache small: it leaves out the app's main files, every lazy
 * route, grammar pack, LiveKit worker, and dev-only debug tool. A page starting
 * without a connection therefore runs only while the browser's HTTP cache still
 * holds those files for its build.
 */
export const APP_SHELL_PRECACHE_PATTERNS = Object.freeze([
  /^index\.html$/,
  /^manifest\.webmanifest$/,
  /^favicon(?:-light)?\.png$/,
  /^favicon\.svg$/,
  /^apple-touch-icon(?:-light)?\.png$/,
  /^icon-(?:192|512)(?:-light)?\.png$/,
  /^hush-logo\.svg$/,
  /^rituals-mark\.svg$/,
  /^assets\/index-[A-Za-z0-9_-]+\.(?:js|css)$/,
  /^assets\/vendor-react-[A-Za-z0-9_-]+\.js$/,
  /^assets\/hush_crypto(?:_bg)?-[A-Za-z0-9_-]+\.(?:js|wasm)$/,
  /^assets\/geist-[A-Za-z0-9_-]+\.woff2$/,
  /^assets\/workbox-window(?:\.prod\.es5)?-[A-Za-z0-9_-]+\.js$/,
]);

export function shouldPrecacheUrl(url) {
  const normalized = String(url).replace(/^\//, "").split("?")[0];
  return APP_SHELL_PRECACHE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterPrecacheManifest(entries) {
  const seen = new Set();
  const manifest = [];
  for (const entry of entries) {
    if (!shouldPrecacheUrl(entry.url) || seen.has(entry.url)) continue;
    seen.add(entry.url);
    manifest.push(entry);
  }
  return {
    manifest,
    warnings: [],
  };
}

/**
 * URL paths that must never become the offline fallback for navigations.
 * navigateFallbackDenylist takes RegExp.
 */
export const NAVIGATE_FALLBACK_DENYLIST = Object.freeze([
  /^\/api\//,
  /^\/ws(\?|$)/,
  /^\/livekit\//,
  /^\/admin(?:\/|$)/,
  // Rituals fork: the AGPL source listing must reach the server, never the
  // SPA shell (the About dialog links here).
  /^\/source(?:\/|$)/,
]);

/**
 * Runtime caching rules. We declare ONE rule, NetworkFirst for documents, and
 * it does not decide what a navigation gets: navigateFallback answers every
 * navigation its denylist allows from the precached shell before this rule is
 * consulted, and this rule refuses whatever that denylist refuses. Updates are
 * not found here (see the top of this file). Everything else either lives in
 * the precache (static shell) or bypasses the SW entirely (API, WS, LiveKit,
 * attachments).
 *
 * urlPattern uses a function so we can keep the denylist authoritative.
 */
// The runtime caching `urlPattern` function below is serialized into the
// generated Service Worker via `Function.prototype.toString()`. Workbox does
// NOT bundle imports from this module into the SW, so the function MUST be
// self-contained — every regex it consults is declared inline. Reference
// `NEVER_CACHE_URL_PATTERNS` from this module body only for tests / vite
// config; never close over it inside `urlPattern`.
export const RUNTIME_CACHING = Object.freeze([
  {
    // Match top-level navigations (HTML documents) only and refuse to handle
    // API / WS / LiveKit / attachment URLs even if a navigation somehow
    // points at them. The denylist is duplicated in literal form so the
    // function survives serialization into the SW.
    urlPattern: ({ request, url }) => {
      if (request.destination !== "document") return false;
      const denyPatterns = [
        /\/api\//,
        /\/ws(\?|$)/,
        /\/livekit\//,
        /^\/admin(?:\/|$)/,
        /\/api\/.*\/attachments\//,
        /\/api\/attachments\//,
        /^\/source(?:\/|$)/,
      ];
      for (let i = 0; i < denyPatterns.length; i++) {
        if (denyPatterns[i].test(url.pathname)) return false;
      }
      return true;
    },
    handler: "NetworkFirst",
    options: {
      cacheName: "hush-html-shell",
      networkTimeoutSeconds: 3,
      expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 },
    },
  },
]);

/**
 * Top-level options handed to vite-plugin-pwa's `VitePWA({...})`.
 *
 * registerType is "prompt": the new SW never activates itself. It activates
 * when `updateSW(true)` runs from the Update Required dialog, when every page
 * using the old SW has closed, or (Rituals fork) at the very start of a page
 * load that finds itself the only open Space page, before any app module runs
 * (src/lib/quietUpdate.ts). We never auto-skip-waiting while the app runs —
 * auto-activation could swap the JS bundle out from under a tab that is
 * mid-flight on an MLS commit or vault operation.
 */
/**
 * Web app manifest for the Rituals Space build (Rituals fork): the product
 * is "Space" inside Rituals, so the installed name, icons and colours follow
 * Rituals (Bone page tone, the Rituals mark).
 */
export const RITUALS_SPACE_MANIFEST = Object.freeze({
  name: "Rituals Space",
  short_name: "Space",
  description:
    "A private space for the people on a shared Rituals task. Messages and calls are end-to-end encrypted.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#EAE6E0",
  theme_color: "#EAE6E0",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ],
});

export const PWA_OPTIONS = Object.freeze({
  registerType: "prompt",
  manifest: RITUALS_SPACE_MANIFEST,
  injectRegister: null, // we register manually from src/lib/pwaUpdate.js
  // Do NOT enable PWA in dev. dev runs with the source modules + HMR; an
  // active SW would intercept module requests and complicate debugging.
  devOptions: { enabled: false },
  workbox: {
    globPatterns: [...PRECACHE_GLOB_PATTERNS],
    globIgnores: [...PRECACHE_GLOB_IGNORE],
    manifestTransforms: [filterPrecacheManifest],
    navigateFallback: "index.html",
    navigateFallbackDenylist: [...NAVIGATE_FALLBACK_DENYLIST],
    // Hush-crypto ships a sizeable WASM module that we DO want precached; the
    // precache manifest size limit needs to accommodate it (~10 MB headroom is
    // generous and still cheap).
    maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
    runtimeCaching: [...RUNTIME_CACHING],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
  },
});
