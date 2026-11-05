/**
 * Rituals fork (2026-11-05): the single Space instance for the same-site
 * frame host. The rituals.app web client frames this bundle from
 * https://space.rituals.app (same site as rituals.app, so the frame keeps its
 * storage), but the Space server, its accounts and its WebSocket stay at
 * https://space.rit.al. On the frame host every auth, API and WebSocket call
 * is pinned there; the host's Caddy CSP allows exactly that connect-src.
 *
 * Elsewhere (space.rit.al itself, local dev) nothing is pinned and the page
 * origin stays the default, as upstream. A local stack can pin explicitly
 * with VITE_RITUALS_SPACE_INSTANCE_URL.
 */

export const RITUALS_SPACE_INSTANCE_URL = 'https://space.rit.al';
/** Page origins that serve this bundle for the Rituals frame. */
export const RITUALS_SPACE_WEB_ORIGINS = Object.freeze(['https://space.rituals.app']);

function bareOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Literal read so Vite replaces it at build time (envPrefix includes VITE_RITUALS_).
const ENV_PIN = bareOrigin(import.meta.env.VITE_RITUALS_SPACE_INSTANCE_URL);

/**
 * @param {string|null|undefined} pageOrigin
 * @param {string|null} [envPin] build-time override (tests pass it explicitly)
 * @returns {string|null} the instance every call must use, or null when unpinned
 */
export function pinnedSpaceInstanceUrl(pageOrigin, envPin = ENV_PIN) {
  if (envPin) return envPin;
  const origin = bareOrigin(pageOrigin);
  return origin && RITUALS_SPACE_WEB_ORIGINS.includes(origin) ? RITUALS_SPACE_INSTANCE_URL : null;
}

/** @returns {string|null} the pin for this page, if any */
export function currentPinnedSpaceInstanceUrl() {
  if (typeof window === 'undefined') return null;
  return pinnedSpaceInstanceUrl(window.location?.origin);
}

/** The instance origin to use where upstream falls back to `location.origin`. */
export function pageInstanceOrigin() {
  if (typeof window === 'undefined') return '';
  return currentPinnedSpaceInstanceUrl() || window.location.origin;
}
