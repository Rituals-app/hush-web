/**
 * Rituals fork (2026-11-05): storage partition probe for the rituals.app frame.
 *
 * The Space identity lives in this origin's IndexedDB and localStorage. In a
 * frame, an engine may hand the page a separate (partitioned or transient)
 * store instead; booting there would mint a second identity that vanishes or
 * splits from the person's real one. So, before any identity work, a framed
 * page checks that it sees the same store as a top-level visit did:
 *
 * - every top-level visit writes one nonce to a first-party cookie
 *   (`rituals_space_seen`) and to IndexedDB (`rituals-space-probe`);
 * - a framed page is unpartitioned only when document.hasStorageAccess() is
 *   not false AND both markers exist AND they match.
 *
 * A cookie and IndexedDB that agree mean both stores are the top-level ones
 * (an engine that partitions one partitions both, or neither has the nonce).
 * Cost: a person's first Space in a given browser opens once in its own tab.
 * decideFramePartition is pure so the rule can be tuned per engine.
 */

export const PROBE_COOKIE = 'rituals_space_seen';
const PROBE_DB = 'rituals-space-probe';
const PROBE_STORE = 'kv';
const PROBE_KEY = 'seen';
const NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * @param {{ hasStorageAccess: boolean|null, cookieNonce: string|null, idbNonce: string|null }} facts
 * @returns {{ partitioned: boolean, reason: 'storage_access_denied'|'no_marker'|'marker_mismatch'|null }}
 */
export function decideFramePartition({ hasStorageAccess, cookieNonce, idbNonce }) {
  if (hasStorageAccess === false) return { partitioned: true, reason: 'storage_access_denied' };
  const cookie = NONCE_RE.test(cookieNonce || '') ? cookieNonce : null;
  const idb = NONCE_RE.test(idbNonce || '') ? idbNonce : null;
  if (!cookie || !idb) return { partitioned: true, reason: 'no_marker' };
  if (cookie !== idb) return { partitioned: true, reason: 'marker_mismatch' };
  return { partitioned: false, reason: null };
}

/** @param {string} cookieHeader */
export function readProbeCookie(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PROBE_COOKIE) return rest.join('=') || null;
  }
  return null;
}

function openProbeDb() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(PROBE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PROBE_STORE)) request.result.createObjectStore(PROBE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readIdbNonce() {
  const db = await openProbeDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(PROBE_STORE, 'readonly').objectStore(PROBE_STORE).get(PROBE_KEY);
      request.onsuccess = () => {
        db.close();
        resolve(typeof request.result === 'string' ? request.result : null);
      };
      request.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeIdbNonce(nonce) {
  const db = await openProbeDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(PROBE_STORE, 'readwrite');
      tx.objectStore(PROBE_STORE).put(nonce, PROBE_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

async function readHasStorageAccess() {
  try {
    if (typeof document.hasStorageAccess !== 'function') return null;
    return Boolean(await document.hasStorageAccess());
  } catch {
    return null;
  }
}

/**
 * Framed pages only. Reads nothing of the identity and writes nothing but the
 * probe database it opens.
 *
 * @returns {Promise<{ partitioned: boolean, reason: string|null }>}
 */
export async function probeFrameStorage() {
  const [hasStorageAccess, idbNonce] = await Promise.all([readHasStorageAccess(), readIdbNonce()]);
  return decideFramePartition({
    hasStorageAccess,
    cookieNonce: readProbeCookie(document.cookie),
    idbNonce,
  });
}

function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * After the account check on a top-level visit (or a frame that passed the
 * probe): (re)writes the matching markers so later frames can
 * prove they share this store. Keeps an existing matching pair.
 */
export async function writeProbeMarkers() {
  try {
    const cookieNonce = readProbeCookie(document.cookie);
    const idbNonce = await readIdbNonce();
    if (cookieNonce && NONCE_RE.test(cookieNonce) && cookieNonce === idbNonce) return;
    const nonce = newNonce();
    if (!(await writeIdbNonce(nonce))) return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${PROBE_COOKIE}=${nonce}; Path=/; Max-Age=34560000; SameSite=Lax${secure}`;
  } catch {
    // No storage: frames will keep asking for a top-level visit.
  }
}
