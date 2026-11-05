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
/** The Rituals account (ticket `acct`) this browser's Space identity belongs to. */
export const SPACE_ACCOUNT_KEY = 'rituals_space_account';
const ACCOUNT_RE = /^[0-9a-f]{64}$/;
/** Databases that point the app at an existing identity; if either survives, the newcomer could enter as the old one. */
const IDENTITY_POINTER_DATABASES = ['hush-instances', 'hush-auth-instances'];

function readStoredSpaceAccount() {
  try {
    return window.localStorage.getItem(SPACE_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => done(true);
      request.onerror = () => done(false);
      // Blocked: another tab still has it open. Give it a moment to close.
      request.onblocked = () => setTimeout(() => done(false), 2500);
    } catch {
      done(false);
    }
  });
}

/**
 * One local Space identity per Rituals account (2026-11-05). A ticket names its
 * Rituals account (`acct`, opaque); when that differs from the account this
 * browser's identity belongs to, every local Space record (identity vault, MLS
 * state, instance registry, settings) is removed before the app starts, so the
 * newcomer gets a fresh identity instead of entering as the previous person.
 * Must run before the app opens any of those databases (src/main.jsx).
 *
 * @param {string|null} ticket
 * @returns {Promise<'skipped'|'same'|'switched'>} rejects when another open tab
 *   keeps the identity pointers in use
 */
export async function ensureSpaceAccount(ticket) {
  if (typeof window === 'undefined' || !ticket) return 'skipped';
  const acct = readSpaceTicketHints(ticket)?.acct;
  if (!acct) return 'skipped';
  if (readStoredSpaceAccount() === acct) return 'same';

  let names = [];
  try {
    if (typeof indexedDB.databases === 'function') {
      names = (await indexedDB.databases()).map((db) => db.name).filter(Boolean);
    }
  } catch {
    names = [];
  }
  for (const pointer of IDENTITY_POINTER_DATABASES) if (!names.includes(pointer)) names.push(pointer);
  const results = await Promise.all(names.map((name) => deleteDatabase(name).then((ok) => [name, ok])));
  if (results.some(([name, ok]) => !ok && IDENTITY_POINTER_DATABASES.includes(name))) {
    throw new Error('space_account_switch_blocked');
  }

  try {
    window.localStorage.clear();
  } catch {
    // Storage unavailable: nothing to clear.
  }
  try {
    window.sessionStorage.clear();
    writeSessionTicket(ticket);
  } catch {
    // The ticket is still held in memory.
  }
  try {
    window.localStorage.setItem(SPACE_ACCOUNT_KEY, acct);
  } catch {
    // Without storage every visit is a fresh identity anyway.
  }
  return 'switched';
}
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

/**
 * File attachments need an S3 bucket on the server (STORAGE_BACKEND=s3); the
 * Rituals host runs without one for now, so the attach button and file drops
 * are off unless the image is built with VITE_RITUALS_ATTACHMENTS=1.
 */
export const SPACE_ATTACHMENTS_ENABLED = envString(import.meta.env.VITE_RITUALS_ATTACHMENTS) === '1';

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
  captureParentOriginFromHash(hash);
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
    if (!ticket) return;
    // A ticket for another Rituals account: reload, so src/main.jsx runs the
    // account check (ensureSpaceAccount) before the app touches the identity.
    const acct = readSpaceTicketHints(ticket)?.acct;
    if (acct && acct !== readStoredSpaceAccount()) {
      window.location.reload();
      return;
    }
    window.dispatchEvent(new CustomEvent(TICKET_EVENT, { detail: { ticket } }));
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
 * @returns {{ dn?: string, un?: string, name?: string, role?: string, exp?: number, acct?: string }|null}
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
      acct: typeof parsed.acct === 'string' && ACCOUNT_RE.test(parsed.acct) ? parsed.acct : undefined,
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
  const out = [];
  let stem;
  if (USERNAME_RE.test(base)) {
    out.push(base);
    stem = base.slice(0, SUFFIX_ROOM).replace(/[-_]+$/g, '') || 'member';
  } else {
    // Too short for a username on its own (a one- or two-letter name):
    // every try carries the suffix ("al-4821"); nothing usable → "member".
    stem = base ? base.slice(0, SUFFIX_ROOM) : 'member';
  }
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
 * @returns {Promise<{ serverId: string, channelId: string|null, othersSeated?: boolean }>}
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
    // Feature-detected: other people already hold seats here. Absent → undefined.
    ...(typeof body?.othersSeated === 'boolean' ? { othersSeated: body.othersSeated } : {}),
  };
}

// ── Peek (Rituals fork, 2026-11-05) ─────────────────────────────────────────

const PEEK_TIMEOUT_MS = 6_000;
const peekFlights = new Map();

/**
 * POST /api/rituals/spaces/peek {ticket} → {claimed, selfSeated, othersSeated}.
 * hush-server verifies the ticket like claim does but without a session and
 * without consuming it, so this runs before any identity exists here.
 * `selfSeated`: this Rituals account already holds a seat in the space (an
 * identity exists on another device). `othersSeated`: someone else does.
 *
 * Feature-detected and never throws: a missing endpoint (404), any other
 * error status, a non-JSON body, a network error or a timeout all resolve
 * to null, which callers treat as "behave as before" (register here).
 * Concurrent calls for the same ticket share one request.
 *
 * @param {string} ticket
 * @param {string} [baseUrl] - instance origin ('' = this page's origin)
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ claimed: boolean, selfSeated: boolean, othersSeated: boolean }|null>}
 */
export function peekRitualsSpace(ticket, baseUrl = '', options = {}) {
  if (!isPlausibleSpaceTicket(ticket)) return Promise.resolve(null);
  const key = `${baseUrl || ''}|${ticket}`;
  const existing = peekFlights.get(key);
  if (existing) return existing;
  const promise = runPeek(ticket, baseUrl, options).finally(() => {
    if (peekFlights.get(key) === promise) peekFlights.delete(key);
  });
  peekFlights.set(key, promise);
  return promise;
}

async function runPeek(ticket, baseUrl, { timeoutMs = PEEK_TIMEOUT_MS, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`${baseUrl || ''}/api/rituals/spaces/peek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      credentials: 'omit',
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object') return null;
    return {
      claimed: body.claimed === true,
      selfSeated: body.selfSeated === true,
      othersSeated: body.othersSeated === true,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Maps claim/registration failures onto the branded error states. The
 * server answers every error as JSON `{"error":"<code>"}` (the code ends up
 * in `err.message`):
 *
 * - claim: 400 bad_ticket; 403 ticket_expired | ticket_revoked | banned |
 *   space_full | guest_not_allowed; 409 seat_conflict; 401.
 * - register with the ticket as inviteCode: 400 bad_ticket, 403
 *   ticket_expired, 403 ticket_used (the provisioning step already signs in
 *   with the same key when that key registered; reaching here means the
 *   ticket was used by someone else's key).
 *
 * @param {unknown} err
 * @returns {'expired'|'revoked'|'full'|'used'|'seat_conflict'|'banned'|'invalid'|'unavailable'|'network'}
 */
export function classifySpaceError(err) {
  const status = Number(err?.status);
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  const text = `${code} ${message}`;
  if (code === 'network' || /could not reach|failed to fetch|load failed|networkerror/i.test(message)) {
    return 'network';
  }
  if (/ticket_expired|\bexpired\b/i.test(text)) return 'expired';
  if (/ticket_revoked/i.test(text)) return 'revoked';
  if (/space_full/i.test(text)) return 'full';
  if (/ticket_used/i.test(text)) return 'used';
  if (/seat_conflict/i.test(text) || (status === 409 && /seat/i.test(message))) return 'seat_conflict';
  if (/\bbanned\b|registration blocked/i.test(text)) return 'banned';
  if (/registration limit|registration is closed|spaces_unavailable/i.test(text)) return 'unavailable';
  if (/bad_ticket|guest_not_allowed|invalid|invite code/i.test(text)) return 'invalid';
  if (status === 400 || status === 403) return 'invalid';
  if (status === 404 || status === 503) return 'unavailable';
  // 401 (stale session), 5xx and anything unknown: worth a retry.
  return 'network';
}

// ── Native host bridge (in-app web view) and the Rituals hub frame ─────────

/** The only page allowed to frame the space (the host's CSP frame-ancestors) and to hear from it. */
export const RITUALS_PARENT_ORIGIN = 'https://rituals.app';
const PARENT_ORIGIN_STORAGE_KEY = 'rituals_space_parent_origin';
const FRAME_VISIBLE_EVENT = 'rituals:frame-visible';

let parentOrigin = null;
let frameVisible = true;

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
    || hostname.endsWith('.localhost');
}

/**
 * The parent origin the frame talks to. Always https://rituals.app, except a
 * local stack: a loopback origin passed in the frame URL's fragment (`#o=`) is
 * accepted only when this page is itself loopback or a dev build, so a
 * production page never posts to (or listens to) anything but rituals.app.
 *
 * @param {unknown} candidate the `o` fragment parameter
 * @param {{ pageOrigin?: string|null, dev?: boolean }} [context]
 * @returns {string}
 */
export function resolveRitualsParentOrigin(candidate, context = {}) {
  if (typeof candidate !== 'string' || !candidate) return RITUALS_PARENT_ORIGIN;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return RITUALS_PARENT_ORIGIN;
  }
  if (url.origin === RITUALS_PARENT_ORIGIN) return RITUALS_PARENT_ORIGIN;
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHost(url.hostname)) {
    return RITUALS_PARENT_ORIGIN;
  }
  if (url.origin !== candidate.replace(/\/$/, '')) return RITUALS_PARENT_ORIGIN;
  let pageIsLoopback = false;
  try {
    pageIsLoopback = Boolean(context.pageOrigin) && isLoopbackHost(new URL(context.pageOrigin).hostname);
  } catch {
    pageIsLoopback = false;
  }
  return pageIsLoopback || context.dev === true ? url.origin : RITUALS_PARENT_ORIGIN;
}

function captureParentOriginFromHash(hash) {
  if (typeof hash !== 'string' || hash.length < 2) return;
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('o');
  if (!raw) return;
  parentOrigin = resolveRitualsParentOrigin(raw, {
    pageOrigin: window.location.origin,
    dev: Boolean(import.meta.env.DEV),
  });
  try {
    sessionStorage.setItem(PARENT_ORIGIN_STORAGE_KEY, parentOrigin);
  } catch {
    // Memory still holds it for this page load.
  }
}

/** @returns {string} the origin frame messages go to and are accepted from */
export function ritualsParentOrigin() {
  if (parentOrigin) return parentOrigin;
  let stored = null;
  try {
    stored = sessionStorage.getItem(PARENT_ORIGIN_STORAGE_KEY);
  } catch {
    stored = null;
  }
  parentOrigin = stored
    ? resolveRitualsParentOrigin(stored, {
      pageOrigin: typeof window !== 'undefined' ? window.location.origin : null,
      dev: Boolean(import.meta.env.DEV),
    })
    : RITUALS_PARENT_ORIGIN;
  return parentOrigin;
}

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

/** True when this page is framed (the space hub on rituals.app shows the space in an iframe). */
export function isFramed() {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Embedded mode (INTEGRATED.md §10): framed by the Rituals hub, or inside the
 * native host. Rituals draws its own rail around the space there, so the
 * space hides its server rail and its links back to Rituals; the channel
 * sidebar, the chat, settings and the About · Source notice stay.
 */
export function isEmbedded() {
  return isFramed() || isInRitualsHost();
}

/**
 * In a frame, the space's own page changes replace its address instead of
 * adding steps. A frame's steps join the tab's history above the hub, so the
 * browser's Back would walk back through channels before it left the hub;
 * nothing in this client goes back by history, so replacing loses nothing.
 * Call once at startup, before the router.
 */
export function installEmbeddedHistory() {
  if (!isFramed()) return;
  try {
    const replace = window.history.replaceState.bind(window.history);
    window.history.pushState = function pushState(state, unused, url) {
      replace(state, unused, url);
    };
  } catch {
    // A locked-down history object: keep the default.
  }
}

/**
 * Posts a message to whatever hosts the space: the native host's handler in
 * the in-app web view, and the Rituals hub (window.parent, only to
 * RITUALS_PARENT_ORIGIN) in a frame; a no-op in a normal browser tab.
 * Messages: `{type:"ready"}` once the space is shown, `{type:"title",
 * title}` with the space name, and `{type:"error", reason}` when the page
 * shows a terminal error instead of a space. In a frame they go to
 * ritualsParentOrigin() (https://rituals.app; a loopback origin on a local
 * stack).
 *
 * @param {{ type: string, [key: string]: unknown }} message
 */
export function postToRitualsHost(message) {
  const handler = getHostHandler();
  if (handler) {
    try {
      handler.postMessage(message);
    } catch {
      // The host went away (page closing); nothing to do.
    }
  }
  postToRitualsParent(message);
}

/**
 * Posts to the Rituals web client only (the frame's parent), never to the
 * native host: `{type:"busy"}`, `{type:"storage-unavailable", reason}` and
 * `{type:"voice", inCall}` are frame-only messages. A no-op when not framed.
 *
 * @param {{ type: string, [key: string]: unknown }} message
 */
export function postToRitualsParent(message) {
  if (!isFramed()) return;
  try {
    window.parent.postMessage(message, ritualsParentOrigin());
  } catch {
    // The frame is closing; nothing to do.
  }
}

/** False while the parent says the Space pane is hidden (`{type:"visible", visible:false}`). */
export function isFrameVisible() {
  return frameVisible;
}

/**
 * @param {(visible: boolean) => void} listener
 * @returns {() => void}
 */
export function subscribeFrameVisible(listener) {
  if (typeof window === 'undefined') return () => {};
  const handler = (event) => listener(Boolean(event?.detail?.visible));
  window.addEventListener(FRAME_VISIBLE_EVENT, handler);
  return () => window.removeEventListener(FRAME_VISIBLE_EVENT, handler);
}

/**
 * Handles one message from the parent. Accepted only from window.parent at
 * ritualsParentOrigin(); anything else is ignored.
 *   {type:"visible", visible:boolean}  the pane was shown or hidden
 *   {type:"escape"}                    Escape pressed in the parent: closes
 *                                      the open menu or dialog as a key would
 *
 * @param {MessageEvent} event
 * @returns {boolean} true when the message was accepted
 */
export function handleRitualsParentMessage(event) {
  if (!event || event.source !== window.parent || event.origin !== ritualsParentOrigin()) return false;
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return false;
  if (data.type === 'visible') {
    if (typeof data.visible !== 'boolean') return false;
    frameVisible = data.visible;
    window.dispatchEvent(new CustomEvent(FRAME_VISIBLE_EVENT, { detail: { visible: data.visible } }));
    return true;
  }
  if (data.type === 'escape') {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return true;
  }
  return false;
}

/** Listens for parent messages when framed. Call once at startup. */
export function installRitualsParentListener() {
  if (!isFramed()) return;
  window.addEventListener('message', handleRitualsParentMessage);
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
