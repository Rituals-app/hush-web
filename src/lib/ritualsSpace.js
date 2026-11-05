/**
 * Rituals Space entry: signed-ticket transport, claim call, error mapping,
 * the native host bridge and the build-time AGPL source links.
 *
 * Rituals fork (2026-11-05). See notes/INTEGRATED.md sections 2 and 5:
 *
 * - The ticket (`rt1.<payload>.<sig>`) arrives only in the URL fragment of
 *   `/space#t=<ticket>`. It is read once, the address bar is rewritten to a
 *   bare `/space` at once, and the ticket lives in memory plus this tab's
 *   sessionStorage (`rituals_space_ticket`). It never goes into a query
 *   string or a path (no `returnTo`, no `buildUnlockResumePath`).
 * - The client never verifies the signature (the server does); it only
 *   reads the display fields (`dn`, `un`, `name`) to pick a username and a
 *   display name for a new identity.
 */

export const SPACE_PATH = '/space';
export const SPACE_TICKET_STORAGE_KEY = 'rituals_space_ticket';
export const PHRASE_UNSAVED_KEY = 'rituals_space_phrase_unsaved';
export const RITUALS_HOME_URL = 'https://rituals.app';

const TICKET_PREFIX = 'rt1.';
const TICKET_MAX_LENGTH = 2048;
const TICKET_RE = /^rt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TICKET_EVENT = 'rituals:space-ticket';

let memoryTicket = null;

// ── Build-time public facts (AGPL notice) ───────────────────────────────────
// Literal `import.meta.env.VITE_RITUALS_*` reads so Vite replaces them at build
// time (envPrefix includes VITE_RITUALS_). Defaults point at the host's
// source listing.

const DEFAULT_SOURCE_URL = 'https://space.rit.al/source/';

function envString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export const SPACE_SOURCE_LINKS = Object.freeze({
  web: envString(import.meta.env.VITE_RITUALS_SOURCE_WEB) || DEFAULT_SOURCE_URL,
  server: envString(import.meta.env.VITE_RITUALS_SOURCE_SERVER) || DEFAULT_SOURCE_URL,
  crypto: envString(import.meta.env.VITE_RITUALS_SOURCE_CRYPTO) || DEFAULT_SOURCE_URL,
  license:
    envString(import.meta.env.VITE_RITUALS_SOURCE_LICENSE)
    || 'https://www.gnu.org/licenses/agpl-3.0.html',
  index: envString(import.meta.env.VITE_RITUALS_SOURCE_INDEX) || DEFAULT_SOURCE_URL,
});

/** Source commit of this build, when the image build passed one. */
export const SPACE_SOURCE_COMMIT = envString(import.meta.env.VITE_RITUALS_SOURCE_COMMIT);

/** The dated modification notice (AGPL-3.0 section 5(a)). */
export const SPACE_MODIFIED_ON = '2026-11-05';

// ── Ticket transport ────────────────────────────────────────────────────────

/**
 * Cheap shape check. The server does the real verification; this only keeps
 * obviously wrong fragments (and oversize input) out of storage.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isPlausibleSpaceTicket(value) {
  return (
    typeof value === 'string'
    && value.length <= TICKET_MAX_LENGTH
    && value.startsWith(TICKET_PREFIX)
    && TICKET_RE.test(value)
  );
}

function isSpacePath(pathname) {
  return pathname === SPACE_PATH || pathname === `${SPACE_PATH}/`;
}

function readTicketFromHash(hash) {
  if (typeof hash !== 'string' || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get('t');
  if (!raw) return null;
  const ticket = raw.trim();
  return isPlausibleSpaceTicket(ticket) ? ticket : null;
}

function writeSessionTicket(ticket) {
  try {
    if (ticket) sessionStorage.setItem(SPACE_TICKET_STORAGE_KEY, ticket);
    else sessionStorage.removeItem(SPACE_TICKET_STORAGE_KEY);
  } catch {
    // Private mode / storage disabled: memory still carries the ticket for
    // this page load.
  }
}

/**
 * Reads `#t=` on `/space`, keeps the ticket in memory and sessionStorage,
 * and rewrites the address bar to a bare `/space` before anything else
 * (router, analytics-free as it is, history) can see it. Safe to call more
 * than once; it acts only when a fragment ticket is present.
 *
 * @param {{ preserveHistoryState?: boolean }} [options]
 * @returns {string|null} the captured ticket, if one was in the URL
 */
export function captureSpaceTicketFromLocation(options = {}) {
  if (typeof window === 'undefined') return null;
  const { pathname, hash } = window.location;
  if (!isSpacePath(pathname) || !hash) return null;

  const ticket = readTicketFromHash(hash);
  // Strip any fragment on /space, even a malformed one: it may still hold
  // ticket-like material.
  try {
    const state = options.preserveHistoryState ? window.history.state : null;
    window.history.replaceState(state, '', SPACE_PATH);
  } catch {
    // replaceState can throw in sandboxed contexts; nothing else to do.
  }
  if (!ticket) return null;

  memoryTicket = ticket;
  writeSessionTicket(ticket);
  return ticket;
}

/**
 * Installs the listener that catches a new ticket delivered to an already
 * running `/space` page (a fragment-only navigation does not reload).
 * Call once at startup.
 */
export function installSpaceTicketListener() {
  if (typeof window === 'undefined') return;
  const onChange = () => {
    const ticket = captureSpaceTicketFromLocation({ preserveHistoryState: true });
    if (ticket) {
      window.dispatchEvent(new CustomEvent(TICKET_EVENT, { detail: { ticket } }));
    }
  };
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
}

/** @returns {string|null} the pending ticket for this tab, if any */
export function readSpaceTicket() {
  if (memoryTicket) return memoryTicket;
  try {
    const stored = sessionStorage.getItem(SPACE_TICKET_STORAGE_KEY);
    if (isPlausibleSpaceTicket(stored)) {
      memoryTicket = stored;
      return stored;
    }
    if (stored) sessionStorage.removeItem(SPACE_TICKET_STORAGE_KEY);
  } catch {
    // ignore
  }
  return null;
}

/**
 * Drops the pending ticket once it has been used (or proved unusable).
 * Only clears when the stored ticket is the one given, so a newer ticket
 * that arrived meanwhile survives.
 *
 * @param {string} [ticket]
 */
export function clearSpaceTicket(ticket) {
  if (ticket && memoryTicket && memoryTicket !== ticket) return;
  memoryTicket = null;
  try {
    const stored = sessionStorage.getItem(SPACE_TICKET_STORAGE_KEY);
    if (!ticket || stored === ticket) sessionStorage.removeItem(SPACE_TICKET_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Subscribes to tickets delivered while the page is running.
 *
 * @param {(ticket: string) => void} listener
 * @returns {() => void}
 */
export function subscribeSpaceTicket(listener) {
  if (typeof window === 'undefined') return () => {};
  const handler = (event) => {
    const ticket = event?.detail?.ticket;
    if (isPlausibleSpaceTicket(ticket)) listener(ticket);
  };
  window.addEventListener(TICKET_EVENT, handler);
  return () => window.removeEventListener(TICKET_EVENT, handler);
}

/** True when this page load is a Rituals space entry with a ticket. */
export function hasPendingSpaceEntry() {
  if (typeof window === 'undefined') return false;
  return isSpacePath(window.location.pathname) && Boolean(readSpaceTicket());
}

// ── Ticket payload (display fields only; unverified) ───────────────────────

function base64UrlToBytes(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decodes the ticket payload for display hints. Never trust these fields
 * for authorization: the server verifies the signature on claim and
 * registration.
 *
 * @param {string} ticket
 * @returns {{ dn?: string, un?: string, name?: string, role?: string, exp?: number }|null}
 */
export function readSpaceTicketHints(ticket) {
  if (!isPlausibleSpaceTicket(ticket)) return null;
  try {
    const [, payload] = ticket.split('.');
    const json = new TextDecoder().decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      dn: typeof parsed.dn === 'string' ? parsed.dn : undefined,
      un: typeof parsed.un === 'string' ? parsed.un : undefined,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      role: typeof parsed.role === 'string' ? parsed.role : undefined,
      exp: Number.isFinite(parsed.exp) ? parsed.exp : undefined,
    };
  } catch {
    return null;
  }
}

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const MAX_USERNAME_ATTEMPTS = 6;
const SUFFIX_ROOM = 27; // 32 - "-NNNN"

/**
 * Lower-case ASCII slug of a display name for a username: accents folded,
 * anything else turned into single hyphens.
 *
 * @param {string|undefined} value
 * @returns {string}
 */
export function slugifySpaceUsername(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

function randomDigits(count) {
  const values = new Uint32Array(count);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => String(v % 10)).join('');
}

/**
 * Username candidates for a new identity: the ticket's `un`, else a slug of
 * `dn`, then the same base plus `-` and four random digits (six tries in all).
 *
 * @param {{ dn?: string, un?: string }|null} hints
 * @returns {string[]}
 */
export function spaceUsernameCandidates(hints) {
  let base = typeof hints?.un === 'string' && USERNAME_RE.test(hints.un) ? hints.un : '';
  if (!base) base = slugifySpaceUsername(hints?.dn);
  if (!USERNAME_RE.test(base)) base = 'member';
  const stem = base.slice(0, SUFFIX_ROOM).replace(/[-_]+$/g, '') || 'member';
  const out = [base];
  const seen = new Set(out);
  while (out.length < MAX_USERNAME_ATTEMPTS) {
    const candidate = `${stem}-${randomDigits(4)}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Display name for a new identity: the ticket's `dn` (1..64 code points),
 * else the username.
 *
 * @param {{ dn?: string }|null} hints
 * @param {string} fallback
 * @returns {string}
 */
export function spaceDisplayName(hints, fallback) {
  const dn = typeof hints?.dn === 'string' ? hints.dn.trim() : '';
  if (!dn) return fallback;
  return Array.from(dn).slice(0, 64).join('');
}

// ── Claim ───────────────────────────────────────────────────────────────────

/**
 * POST /api/rituals/spaces/claim {ticket} → {serverId, channelId}.
 * Idempotent on the server (seat upsert), so repeat taps land in the same
 * space.
 *
 * @param {string} token - JWT for the space origin
 * @param {string} ticket
 * @param {string} [baseUrl] - instance origin ('' = this page's origin)
 * @returns {Promise<{ serverId: string, channelId: string|null }>}
 */
export async function claimRitualsSpace(token, ticket, baseUrl = '') {
  const url = `${baseUrl || ''}/api/rituals/spaces/claim`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ticket }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (err) {
    const networkError = new Error('Could not reach the space.');
    networkError.code = 'network';
    networkError.cause = err;
    throw networkError;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(
      (body && (body.error_code || body.code || body.error)) || `claim ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
  const serverId = typeof body?.serverId === 'string' ? body.serverId : null;
  if (!serverId) {
    const err = new Error('claim returned no space');
    err.status = 502;
    throw err;
  }
  return {
    serverId,
    channelId: typeof body?.channelId === 'string' && body.channelId ? body.channelId : null,
  };
}

/**
 * Maps claim/registration failures onto the branded error states.
 *
 * @param {unknown} err
 * @returns {'expired'|'seat_conflict'|'banned'|'invalid'|'unavailable'|'network'}
 */
export function classifySpaceError(err) {
  const status = Number(err?.status);
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  if (code === 'network' || /could not reach|failed to fetch|load failed|networkerror/i.test(message)) {
    return 'network';
  }
  if (/expired/i.test(message)) return 'expired';
  if (status === 409 && /seat/i.test(message)) return 'seat_conflict';
  if (/seat_conflict/i.test(message)) return 'seat_conflict';
  if (/banned|registration blocked/i.test(message)) return 'banned';
  if (/registration limit|registration is closed|spaces_unavailable/i.test(message)) return 'unavailable';
  if (/bad_ticket|ticket_used|invalid|invite code/i.test(message)) return 'invalid';
  if (status === 400 || status === 403) return 'invalid';
  if (status === 404 || status === 503) return 'unavailable';
  // 401 (stale session), 5xx and anything unknown: worth a retry.
  return 'network';
}

// ── Native host bridge (in-app web view) ────────────────────────────────────

/** @returns {{ postMessage: (msg: unknown) => void }|null} */
function getHostHandler() {
  if (typeof window === 'undefined') return null;
  const handler = window.webkit?.messageHandlers?.ritualsSpace;
  return handler && typeof handler.postMessage === 'function' ? handler : null;
}

/** True inside the Rituals iOS / Mac app's in-app web view. */
export function isInRitualsHost() {
  return Boolean(getHostHandler());
}

/**
 * Posts a message to the native host; a no-op in a normal browser tab.
 * Messages: `{type:"ready"}` once the space is shown, `{type:"title",
 * title}` with the space name, and `{type:"error", reason}` when the page
 * shows a terminal error instead of a space.
 *
 * @param {{ type: string, [key: string]: unknown }} message
 */
export function postToRitualsHost(message) {
  const handler = getHostHandler();
  if (!handler) return;
  try {
    handler.postMessage(message);
  } catch {
    // The host went away (page closing); nothing to do.
  }
}

// ── Recovery phrase reminder flag ───────────────────────────────────────────

export function isRecoveryPhraseUnsaved() {
  try {
    return localStorage.getItem(PHRASE_UNSAVED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRecoveryPhraseUnsaved(unsaved) {
  try {
    if (unsaved) localStorage.setItem(PHRASE_UNSAVED_KEY, '1');
    else localStorage.removeItem(PHRASE_UNSAVED_KEY);
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rituals:phrase-unsaved', { detail: { unsaved } }));
  }
}
