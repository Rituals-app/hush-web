import { gunzipBytes, gzipBytes } from './compression';

/**
 * Transcript vault.
 *
 * Cross-device-portable, at-rest-encrypted store for the user's recoverable
 * channel transcript cache. The OLD device snapshots its `localPlaintext` rows
 * into an AES-256-GCM blob keyed by an HKDF derivation of the user's root
 * identity private key, transfers that blob to the NEW device via the existing
 * ECDH-encrypted relay envelope, and the NEW device re-encrypts the blob
 * under its own freshly generated nonce before persisting it locally.
 *
 * Security model
 * ---------------
 *
 *  * The transcript-blob symmetric key is derived deterministically from the
 *    user's root identity private key (Ed25519 32-byte seed) via:
 *
 *        TKey = HKDF-SHA256(IKM = rootPrivateKey,
 *                            salt = empty,
 *                            info = "hush-transcript-cache-v1",
 *                            L = 32 bytes)
 *
 *    Because the same root key lives on every device the user owns, every
 *    one of those devices derives the same `TKey` and can therefore decrypt
 *    a transcript blob that any of them produced. This deliberately ties
 *    transcript-cache confidentiality to identity-key confidentiality:
 *    whoever holds the root identity already holds the message account, so
 *    binding transcript access to the same secret is the right granularity.
 *
 *  * The root key is itself protected at rest by the existing identity
 *    vault (PBKDF2-derived AES-GCM under the user's PIN). It only exists in
 *    plaintext in browser memory while the vault is unlocked. This means
 *    the transcript blob is also only readable while the vault is unlocked
 *    — when the vault relocks, the in-memory cache is cleared and the
 *    encrypted blob on disk cannot be opened until the user re-unlocks.
 *
 *  * The OLD device's PIN is NEVER required on the NEW device. Only the
 *    transferred root key + the transferred encrypted transcript blob are
 *    needed to import.
 *
 *  * On import, the NEW device re-encrypts under a freshly random nonce
 *    (12 bytes) before writing the blob to its own IDB, so the bytes
 *    persisted locally are not bit-for-bit identical to the bytes that
 *    travelled across the relay.
 *
 * Blob format
 * -----------
 *
 *   [12-byte random nonce][AES-GCM ciphertext including 16-byte tag]
 *
 * Plaintext payload format (JSON-encoded UTF-8):
 *
 *   { v: 1, rows: [{ messageId, plaintext, senderId?, timestamp }] }
 *
 * IDB layout
 * ----------
 *
 *   DB:    `hush-transcript-${userId}`
 *   store: `transcript`
 *   row:   { key: 'blob', value: number[]  // serialised Uint8Array }
 */

const TRANSCRIPT_DB_PREFIX = 'hush-transcript-';
const TRANSCRIPT_STORE = 'transcript';
const TRANSCRIPT_ROW_KEY = 'blob';
const TRANSCRIPT_DB_VERSION = 1;
const TRANSCRIPT_PAYLOAD_VERSION = 2;
const TRANSCRIPT_HKDF_INFO = new TextEncoder().encode('hush-transcript-cache-v1');
const NONCE_LENGTH = 12;
const TRANSCRIPT_PAYLOAD_GZIP_PREFIX = new Uint8Array([0x48, 0x54, 0x32, 0x00]); // "HT2\0"
// V3 framed wire format magic. Used only for the device-link transcript
// payload that travels OLD → NEW. At-rest blobs continue to use V2
// (a single nonce + AES-GCM ciphertext + inner gzipped JSON), which is
// preserved unchanged for backward compatibility. See encryptTranscriptBlobFramed
// and createFramedTranscriptStreamDecoder.
const TRANSCRIPT_FRAMED_V3_MAGIC = new Uint8Array([0x48, 0x54, 0x33, 0x00]); // "HT3\0"
const TRANSCRIPT_FRAMED_DEFAULT_ROWS_PER_FRAME = 1024;
// V3 at-rest IDB layout:
//   key 'v3-meta'           → { version: 3, rowsPerFrame, frameCount, totalRows }
//   key 'v3-frame:0..N-1'   → number[] of (12-byte nonce ‖ AES-GCM ciphertext)
// Legacy V1/V2/V3-monolithic blobs continue to live under TRANSCRIPT_ROW_KEY
// ('blob') and are read transparently when no v3-meta row exists.
const TRANSCRIPT_AT_REST_META_KEY = 'v3-meta';
const TRANSCRIPT_AT_REST_FRAME_PREFIX = 'v3-frame:';
const TRANSCRIPT_AT_REST_VERSION = 3;
const TRANSCRIPT_AT_REST_DEFAULT_ROWS_PER_FRAME = 1024;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derives the AES-256-GCM transcript-cache key from the user's root identity
 * private key. The derivation is deterministic (same root → same key) so any
 * device the user links can decrypt blobs produced by any other.
 *
 * @param {Uint8Array} rootPrivateKey - 32-byte Ed25519 seed.
 * @returns {Promise<CryptoKey>}
 */
export async function deriveTranscriptKey(rootPrivateKey) {
  if (!(rootPrivateKey instanceof Uint8Array) || rootPrivateKey.byteLength === 0) {
    throw new Error('[transcriptVault] root private key must be a non-empty Uint8Array');
  }
  const ikm = await crypto.subtle.importKey(
    'raw',
    rootPrivateKey,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: TRANSCRIPT_HKDF_INFO,
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Blob encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Serialises and encrypts an array of transcript rows.
 *
 * @param {CryptoKey} key - AES-GCM key from `deriveTranscriptKey`.
 * @param {Array<{messageId: string, plaintext: string, senderId?: string, timestamp: number}>} rows
 * @returns {Promise<Uint8Array>}
 */
export async function encryptTranscriptBlob(key, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const payload = JSON.stringify({ v: TRANSCRIPT_PAYLOAD_VERSION, rows: safeRows });
  const payloadBytes = new TextEncoder().encode(payload);
  const compressedPayload = await gzipBytes(payloadBytes);
  const plaintext = new Uint8Array(
    TRANSCRIPT_PAYLOAD_GZIP_PREFIX.byteLength + compressedPayload.byteLength,
  );
  plaintext.set(TRANSCRIPT_PAYLOAD_GZIP_PREFIX, 0);
  plaintext.set(compressedPayload, TRANSCRIPT_PAYLOAD_GZIP_PREFIX.byteLength);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    plaintext,
  );
  const ciphertext = new Uint8Array(ciphertextBuf);
  const out = new Uint8Array(NONCE_LENGTH + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(ciphertext, NONCE_LENGTH);
  return out;
}

/**
 * Build a V3 framed transcript blob for the device-link wire. Each frame
 * contains a contiguous slice of the rows array, gzipped and AES-GCM-
 * encrypted independently. Consumers can decrypt frames as they arrive
 * without buffering the whole transcript ciphertext in memory.
 *
 * Layout:
 *
 *     [4-byte magic "HT3\0"]
 *     for each frame:
 *       [u32 ciphertextLen LE][12-byte nonce][ciphertext]
 *     [u32 0 LE]                     // end-of-stream sentinel
 *
 *     ciphertext = AES-GCM(K, nonce, gzip(JSON.stringify(rowsSubset)))
 *
 * The frame size is configurable; the default keeps each frame's
 * plaintext small enough that the streaming receiver's per-frame
 * working set is bounded by the frame plaintext, not by the whole
 * transcript.
 */
export async function encryptTranscriptBlobFramed(key, rows, rowsPerFrame = TRANSCRIPT_FRAMED_DEFAULT_ROWS_PER_FRAME) {
  if (!(key instanceof CryptoKey)) {
    throw new Error('[transcriptVault] key must be a CryptoKey');
  }
  if (!Number.isInteger(rowsPerFrame) || rowsPerFrame <= 0) {
    throw new Error('[transcriptVault] rowsPerFrame must be a positive integer');
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const parts = [TRANSCRIPT_FRAMED_V3_MAGIC];
  for (let i = 0; i < safeRows.length; i += rowsPerFrame) {
    const subset = safeRows.slice(i, i + rowsPerFrame);
    const json = new TextEncoder().encode(JSON.stringify(subset));
    const compressed = await gzipBytes(json);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce }, key, compressed,
    ));
    const lenLE = new Uint8Array(4);
    new DataView(lenLE.buffer).setUint32(0, ciphertext.byteLength, true);
    parts.push(lenLE);
    parts.push(nonce);
    parts.push(ciphertext);
  }
  const sentinel = new Uint8Array(4); // length=0
  parts.push(sentinel);
  return concatUint8(parts);
}

function concatUint8(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function bytesEqual(a, b, len = a.byteLength) {
  if (a.byteLength < len || b.byteLength < len) return false;
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Streaming V3 transcript decoder. Caller feeds inbound bytes (in any
 * chunking) via `feed(bytes)`; the decoder parses headers, decrypts each
 * frame as soon as enough bytes arrive, parses the rows JSON, and
 * accumulates rows. Caller invokes `finish()` after all bytes have been
 * fed to retrieve the final rows array.
 *
 * If the first 4 bytes do not match the V3 magic, the decoder
 * transparently falls back to "buffer everything, decrypt as a V2/V1
 * blob at finish()" so this entry point can be used unconditionally on
 * the NEW-device import path regardless of whether the OLD device
 * emitted V3 or a legacy whole-blob format.
 *
 * Per-frame peak memory is bounded by the frame's plaintext size; the
 * streamed transcript ciphertext bytes are never accumulated as a single
 * buffer in V3 mode. (V2 fallback path retains its existing whole-blob
 * memory profile, since AES-GCM authentication requires the full
 * ciphertext.)
 */
export function createFramedTranscriptStreamDecoder(key, options = {}) {
  const onFrameRows = typeof options.onFrameRows === 'function' ? options.onFrameRows : null;
  const queue = []; // Uint8Array[]
  let queueByteLen = 0;
  const rows = [];
  let mode = null; // 'v3' or 'v2' once decided
  let stage = 'magic'; // 'magic' | 'frameLen' | 'frameBody' | 'done'
  let pendingFrameLen = 0;

  function take(n) {
    // Pull n bytes from queue head into a single Uint8Array.
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = queue[0];
      const remaining = n - written;
      if (head.byteLength <= remaining) {
        out.set(head, written);
        written += head.byteLength;
        queue.shift();
      } else {
        out.set(head.subarray(0, remaining), written);
        queue[0] = head.subarray(remaining);
        written += remaining;
      }
    }
    queueByteLen -= n;
    return out;
  }

  function readU32LE(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  async function decodeFrame() {
    const nonce = take(NONCE_LENGTH);
    const ct = take(pendingFrameLen);
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce }, key, ct,
    );
    const compressed = new Uint8Array(decryptedBuf);
    const decompressed = await gunzipBytes(compressed);
    const subset = JSON.parse(new TextDecoder().decode(decompressed));
    if (!Array.isArray(subset)) {
      throw new Error('[transcriptVault] framed transcript frame did not decode to an array of rows');
    }
    if (onFrameRows) {
      // Streaming-callback mode: hand the rows to the consumer and
      // do NOT retain them on the decoder. The whole-rows array is
      // never built.
      await onFrameRows(subset);
    } else {
      for (const r of subset) rows.push(r);
    }
  }

  async function pump() {
    while (true) {
      if (mode === null) {
        if (queueByteLen < 4) return;
        const m = take(4);
        if (bytesEqual(m, TRANSCRIPT_FRAMED_V3_MAGIC, 4)) {
          mode = 'v3';
          stage = 'frameLen';
          continue;
        }
        // Not V3: fall back to whole-blob mode. Push the magic bytes
        // back into the queue so finish() can decrypt the assembled
        // V2/V1 blob.
        queue.unshift(m);
        queueByteLen += 4;
        mode = 'v2';
        return;
      }
      if (mode === 'v2') return;
      // mode === 'v3'
      if (stage === 'frameLen') {
        if (queueByteLen < 4) return;
        const lenBytes = take(4);
        const len = readU32LE(lenBytes);
        if (len === 0) {
          stage = 'done';
          return;
        }
        pendingFrameLen = len;
        stage = 'frameBody';
        continue;
      }
      if (stage === 'frameBody') {
        if (queueByteLen < NONCE_LENGTH + pendingFrameLen) return;
        await decodeFrame();
        stage = 'frameLen';
        continue;
      }
      return; // 'done'
    }
  }

  return {
    async feed(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return;
      queue.push(bytes);
      queueByteLen += bytes.byteLength;
      await pump();
    },
    async finish() {
      if (mode === 'v3') {
        if (stage !== 'done') {
          throw new Error('[transcriptVault] framed transcript stream truncated before sentinel');
        }
        return rows;
      }
      // V2 / V1 fallback or empty stream that never declared a magic.
      if (mode === null && queueByteLen === 0) return [];
      // Concatenate the buffered bytes and decrypt as a legacy blob.
      const buffered = take(queueByteLen);
      return decryptTranscriptBlob(key, buffered);
    },
    get _internalState() {
      return { mode, stage, queueByteLen, rowsLen: rows.length };
    },
  };
}

/**
 * Decrypts a transcript blob produced by `encryptTranscriptBlob`.
 *
 * @param {CryptoKey} key
 * @param {Uint8Array} blob
 * @returns {Promise<Array<{messageId: string, plaintext: string, senderId?: string, timestamp: number}>>}
 */
export async function decryptTranscriptBlob(key, blob) {
  if (!(blob instanceof Uint8Array) || blob.byteLength <= NONCE_LENGTH) {
    throw new Error('[transcriptVault] invalid transcript blob');
  }
  // V3 framed: dispatch to the one-shot streaming decoder so callers
  // that hand a fully-buffered V3 blob still get the right rows out.
  if (blob.byteLength >= TRANSCRIPT_FRAMED_V3_MAGIC.byteLength
      && bytesEqual(blob, TRANSCRIPT_FRAMED_V3_MAGIC, TRANSCRIPT_FRAMED_V3_MAGIC.byteLength)) {
    const decoder = createFramedTranscriptStreamDecoder(key);
    await decoder.feed(blob);
    return decoder.finish();
  }
  const nonce = blob.slice(0, NONCE_LENGTH);
  const ciphertext = blob.slice(NONCE_LENGTH);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext,
  );
  const plaintext = new Uint8Array(plaintextBuf);
  let text;
  const hasGzipPrefix = plaintext.byteLength > TRANSCRIPT_PAYLOAD_GZIP_PREFIX.byteLength
    && TRANSCRIPT_PAYLOAD_GZIP_PREFIX.every((byte, index) => plaintext[index] === byte);
  if (hasGzipPrefix) {
    const decompressed = await gunzipBytes(plaintext.slice(TRANSCRIPT_PAYLOAD_GZIP_PREFIX.byteLength));
    text = new TextDecoder().decode(decompressed);
  } else {
    // Backward compatibility: v1 blobs stored raw JSON plaintext.
    text = new TextDecoder().decode(plaintext);
  }
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.rows)) return [];
  return parsed.rows;
}

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

/**
 * Opens the per-user transcript IDB.
 *
 * @param {string} userId
 * @returns {Promise<IDBDatabase>}
 */
export function openTranscriptStore(userId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`${TRANSCRIPT_DB_PREFIX}${userId}`, TRANSCRIPT_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(TRANSCRIPT_STORE)) {
        db.createObjectStore(TRANSCRIPT_STORE, { keyPath: 'key' });
      }
    };
  });
}

/**
 * Persist the encrypted transcript blob into the per-user IDB.
 *
 * @param {IDBDatabase} db
 * @param {Uint8Array} blob
 * @returns {Promise<void>}
 */
export function saveTranscriptBlob(db, blob) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, 'readwrite');
    tx.objectStore(TRANSCRIPT_STORE).put({ key: TRANSCRIPT_ROW_KEY, value: Array.from(blob) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load the encrypted transcript blob from the per-user IDB. Returns null if
 * no blob has been saved yet for this user.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<Uint8Array|null>}
 */
export function loadTranscriptBlob(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, 'readonly');
    const req = tx.objectStore(TRANSCRIPT_STORE).get(TRANSCRIPT_ROW_KEY);
    req.onsuccess = () => {
      const row = req.result;
      if (!row?.value) return resolve(null);
      resolve(new Uint8Array(row.value));
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// V3 framed at-rest persistence
// ---------------------------------------------------------------------------

/**
 * Encrypt and persist transcript rows to IDB as a sequence of
 * independently-AEAD-protected frames. Each frame holds at most
 * `rowsPerFrame` rows; on disk we store one IDB row per frame plus a
 * single meta row carrying the version + frameCount. The encoder
 * writes meta + every frame in a single read-write transaction so a
 * crash mid-write either lands the whole new state or none of it.
 *
 * Memory profile: only one frame's plaintext + ciphertext is in flight
 * at any time. The whole-V2-blob buffer is gone.
 *
 * @param {IDBDatabase} db
 * @param {CryptoKey} key
 * @param {Array<object>} rows
 * @param {number} [rowsPerFrame]
 */
export async function saveFramedTranscriptAtRest(db, key, rows, rowsPerFrame = TRANSCRIPT_AT_REST_DEFAULT_ROWS_PER_FRAME) {
  if (!(key instanceof CryptoKey)) {
    throw new Error('[transcriptVault] key must be a CryptoKey');
  }
  if (!Array.isArray(rows)) {
    throw new Error('[transcriptVault] rows must be an array');
  }
  if (!Number.isInteger(rowsPerFrame) || rowsPerFrame <= 0) {
    throw new Error('[transcriptVault] rowsPerFrame must be a positive integer');
  }
  const frames = [];
  for (let i = 0; i < rows.length; i += rowsPerFrame) {
    const subset = rows.slice(i, i + rowsPerFrame);
    const json = new TextEncoder().encode(JSON.stringify(subset));
    const compressed = await gzipBytes(json);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce }, key, compressed,
    ));
    const frameBytes = new Uint8Array(NONCE_LENGTH + ciphertext.byteLength);
    frameBytes.set(nonce, 0);
    frameBytes.set(ciphertext, NONCE_LENGTH);
    frames.push(frameBytes);
  }
  const meta = {
    version: TRANSCRIPT_AT_REST_VERSION,
    rowsPerFrame,
    frameCount: frames.length,
    totalRows: rows.length,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, 'readwrite');
    const store = tx.objectStore(TRANSCRIPT_STORE);
    // Replace any prior at-rest state (V1/V2 blob row, or older V3
    // frames). A clear() inside the same tx is atomic: a reader that
    // arrives mid-write sees either the old state or the new state in
    // full, never a half-applied mix.
    store.clear();
    store.put({ key: TRANSCRIPT_AT_REST_META_KEY, value: meta });
    for (let i = 0; i < frames.length; i++) {
      store.put({
        key: `${TRANSCRIPT_AT_REST_FRAME_PREFIX}${i}`,
        value: Array.from(frames[i]),
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Read the V3 at-rest meta row and every frame body. Returns
 * `{ meta, frames }` or `null` if no V3 meta row exists in the store.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<{ meta: { version: number, rowsPerFrame: number, frameCount: number, totalRows: number }, frames: Uint8Array[] } | null>}
 */
export function loadFramedTranscriptAtRest(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, 'readonly');
    const store = tx.objectStore(TRANSCRIPT_STORE);
    const metaReq = store.get(TRANSCRIPT_AT_REST_META_KEY);
    metaReq.onsuccess = () => {
      const row = metaReq.result;
      if (!row?.value) { resolve(null); return; }
      const meta = row.value;
      if (meta.version !== TRANSCRIPT_AT_REST_VERSION) {
        reject(new Error(`[transcriptVault] V3 at-rest meta has unexpected version ${meta.version}`));
        return;
      }
      if (meta.frameCount === 0) { resolve({ meta, frames: [] }); return; }
      const frames = new Array(meta.frameCount);
      let pending = meta.frameCount;
      let aborted = false;
      // Generation-tagged frame keys (slice 11 streaming importer)
      // share the same TRANSCRIPT_AT_REST_FRAME_PREFIX as the
      // slice-10 unversioned keys; the generation suffix in the
      // key disambiguates them. When meta lacks `generation` we
      // read the slice-10 unversioned keys.
      const keyPrefix = meta.generation
        ? `${TRANSCRIPT_AT_REST_FRAME_PREFIX}${meta.generation}:`
        : TRANSCRIPT_AT_REST_FRAME_PREFIX;
      for (let i = 0; i < meta.frameCount; i++) {
        const req = store.get(`${keyPrefix}${i}`);
        req.onsuccess = () => {
          if (aborted) return;
          const r = req.result;
          if (!r?.value) {
            aborted = true;
            reject(new Error(`[transcriptVault] V3 at-rest frame ${i} missing`));
            return;
          }
          frames[i] = new Uint8Array(r.value);
          pending -= 1;
          if (pending === 0) resolve({ meta, frames });
        };
        req.onerror = () => {
          if (aborted) return;
          aborted = true;
          reject(req.error);
        };
      }
    };
    metaReq.onerror = () => reject(metaReq.error);
  });
}

/**
 * Decrypt a sequence of V3 at-rest frame buffers and return the
 * concatenated rows. Each frame is independently AES-GCM-decrypted +
 * gunzipped + JSON-parsed; a corrupt frame fails the AEAD tag and is
 * surfaced as a thrown error before any subsequent frame is touched.
 *
 * @param {CryptoKey} key
 * @param {Uint8Array[]} frames
 * @returns {Promise<Array<object>>}
 */
export async function decodeFramedTranscriptAtRest(key, frames) {
  const rows = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!(frame instanceof Uint8Array) || frame.byteLength <= NONCE_LENGTH) {
      throw new Error(`[transcriptVault] V3 at-rest frame ${i} truncated`);
    }
    const nonce = frame.subarray(0, NONCE_LENGTH);
    const ciphertext = frame.subarray(NONCE_LENGTH);
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce }, key, ciphertext,
    );
    const compressed = new Uint8Array(decryptedBuf);
    const decompressed = await gunzipBytes(compressed);
    const subset = JSON.parse(new TextDecoder().decode(decompressed));
    if (!Array.isArray(subset)) {
      throw new Error(`[transcriptVault] V3 at-rest frame ${i} did not decode to an array`);
    }
    for (const r of subset) rows.push(r);
  }
  return rows;
}

/**
 * Streaming at-rest importer. Lets a caller append decoded rows
 * frame-by-frame and persist them to IDB without ever holding the
 * full row set in a single buffer. Exactly one importer instance
 * is active per import; a fresh import generates a new generation
 * token so its frame keys do not collide with any prior or
 * orphaned frames.
 *
 * Atomic-visibility contract:
 *
 *   - `appendFrame(rows)` writes one IDB row per call under
 *     `v3-frame:{generation}:{idx}` keys. Readers continue to see
 *     whatever the *previous* committed v3-meta points at; the new
 *     frames are invisible until commit.
 *   - `commit()` runs a single read-write IDB transaction that
 *     deletes every key that is NOT one of our generation's frames
 *     (legacy 'blob', any prior 'v3-meta', any other 'v3-frame:*'
 *     including orphans from a previous failed import) and then
 *     writes the new 'v3-meta'. Visibility flips atomically.
 *   - `abort()` runs a read-write transaction that deletes ONLY our
 *     generation's frames. The committed state is unchanged.
 *
 * In-memory cache contract:
 *
 *   - `init()` calls `beginTranscriptCacheStream`, clears the cache,
 *     and stamps a fresh generation. The cache is `loaded=false`
 *     during streaming.
 *   - `appendFrame(rows)` calls `appendTranscriptCacheRows`, which
 *     no-ops if the generation has been bumped by a competing
 *     write (vault lock, fresh `setTranscriptCache`).
 *   - `commit()` calls `finalizeTranscriptCacheStream` to flip
 *     `loaded=true` if the generation still matches.
 *   - `abort()` calls `clearTranscriptCache` so a partially-streamed
 *     cache never becomes visible as the authoritative state.
 */
export function createStreamingTranscriptImporter({ db, key, userId, rowsPerFrame = TRANSCRIPT_AT_REST_DEFAULT_ROWS_PER_FRAME }) {
  if (!(db) || typeof db.transaction !== 'function') {
    throw new Error('[transcriptVault] streaming importer requires an open IDBDatabase');
  }
  if (!(key instanceof CryptoKey)) {
    throw new Error('[transcriptVault] streaming importer requires a CryptoKey');
  }
  if (!Number.isInteger(rowsPerFrame) || rowsPerFrame <= 0) {
    throw new Error('[transcriptVault] rowsPerFrame must be a positive integer');
  }
  const generation = `${Date.now().toString(36)}-${crypto
    .getRandomValues(new Uint32Array(2))
    .reduce((acc, n) => acc + n.toString(36), '')}`;
  const cacheGen = beginTranscriptCacheStream(userId);
  let frameCount = 0;
  let totalRows = 0;
  let closed = false;

  function frameKeyFor(idx) {
    return `${TRANSCRIPT_AT_REST_FRAME_PREFIX}${generation}:${idx}`;
  }

  async function persistFrameBytes(idx, bytes) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPT_STORE, 'readwrite');
      tx.objectStore(TRANSCRIPT_STORE).put({
        key: frameKeyFor(idx),
        value: Array.from(bytes),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function deleteOurFramesOnly() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPT_STORE, 'readwrite');
      const store = tx.objectStore(TRANSCRIPT_STORE);
      const prefix = `${TRANSCRIPT_AT_REST_FRAME_PREFIX}${generation}:`;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        const k = c.key;
        if (typeof k === 'string' && k.startsWith(prefix)) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function commitAtomically() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPT_STORE, 'readwrite');
      const store = tx.objectStore(TRANSCRIPT_STORE);
      const ourPrefix = `${TRANSCRIPT_AT_REST_FRAME_PREFIX}${generation}:`;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) {
          // Cursor exhausted. Write the new meta. Visibility flips on tx commit.
          store.put({
            key: TRANSCRIPT_AT_REST_META_KEY,
            value: {
              version: TRANSCRIPT_AT_REST_VERSION,
              rowsPerFrame,
              frameCount,
              totalRows,
              generation,
            },
          });
          return;
        }
        const k = c.key;
        if (k === TRANSCRIPT_AT_REST_META_KEY) {
          c.delete();
        } else if (k === TRANSCRIPT_ROW_KEY) {
          // legacy V1/V2 'blob' row: drop on commit so readers prefer the V3 frames
          c.delete();
        } else if (typeof k === 'string'
            && k.startsWith(TRANSCRIPT_AT_REST_FRAME_PREFIX)
            && !k.startsWith(ourPrefix)) {
          // any prior or orphaned V3 frame from another generation
          c.delete();
        }
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    /** Encrypt and persist one frame; also extend the in-memory cache. */
    async appendFrame(rows) {
      if (closed) throw new Error('[transcriptVault] streaming importer already closed');
      if (!Array.isArray(rows) || rows.length === 0) return;
      const json = new TextEncoder().encode(JSON.stringify(rows));
      const compressed = await gzipBytes(json);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce }, key, compressed,
      ));
      const frameBytes = new Uint8Array(NONCE_LENGTH + ciphertext.byteLength);
      frameBytes.set(nonce, 0);
      frameBytes.set(ciphertext, NONCE_LENGTH);
      await persistFrameBytes(frameCount, frameBytes);
      appendTranscriptCacheRows(cacheGen, rows);
      frameCount += 1;
      totalRows += rows.length;
    },
    /** Atomically swap in the new at-rest state and finalise the cache. */
    async commit() {
      if (closed) throw new Error('[transcriptVault] streaming importer already closed');
      closed = true;
      await commitAtomically();
      finalizeTranscriptCacheStream(cacheGen);
      return { generation, frameCount, totalRows };
    },
    /** Discard partial state. The committed at-rest state is unchanged. */
    async abort() {
      if (closed) return;
      closed = true;
      try { await deleteOurFramesOnly(); } catch { /* best-effort */ }
      // Bump generation so a stale appendFrame promise that resolves
      // after abort can never sneak into the cache.
      clearTranscriptCache();
    },
    get _internals() {
      return { generation, frameCount, totalRows, closed, cacheGen };
    },
  };
}

/**
 * Drops the per-user transcript IDB. Used by full logout / vault wipe paths.
 *
 * @param {string} userId
 * @returns {Promise<void>}
 */
export function deleteTranscriptDatabase(userId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`${TRANSCRIPT_DB_PREFIX}${userId}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// In-memory runtime cache (cleared on vault lock)
//
// Concurrency: every cache state transition (clear / set / on-disk load
// completion) bumps a monotonic `generation` counter. Async on-disk loads
// snapshot the generation at start and only commit their result if the
// generation has not moved. This prevents a fire-and-forget hydrate started
// before vault lock from re-populating the cache after the vault relocked.
// ---------------------------------------------------------------------------

const _state = {
  cache: new Map(),
  loaded: false,
  userId: null,
  generation: 0,
};

function bumpTranscriptGeneration() {
  _state.generation += 1;
  return _state.generation;
}

/**
 * Replace the in-memory transcript cache with the given rows.
 *
 * Bumps the generation counter so any in-flight async hydrate that has
 * already snapshotted the previous generation will detect that its result
 * is stale and skip its own commit.
 *
 * @param {string} userId
 * @param {Array<{messageId: string, plaintext: string, senderId?: string, timestamp: number}>} rows
 */
/**
 * Begin an incremental cache hydration session. Clears the existing
 * cache, sets `userId`, leaves `loaded=false` so consumers know the
 * cache is mid-stream, and bumps the generation counter so any
 * pre-existing async hydrate that snapshotted the prior generation
 * will detect that its result is stale.
 *
 * Returns the generation token that subsequent calls to
 * `appendTranscriptCacheRows` and `finalizeTranscriptCacheStream`
 * must echo back. Mismatching tokens are no-ops, which is the
 * correctness boundary: a vault-lock or a competing
 * `setTranscriptCache` mid-stream bumps the generation, so any
 * subsequent stream operations from the previous import silently
 * abort instead of clobbering fresh state.
 */
export function beginTranscriptCacheStream(userId) {
  _state.cache.clear();
  _state.loaded = false;
  _state.userId = userId ?? null;
  return bumpTranscriptGeneration();
}

/**
 * Append rows to the cache mid-stream. No-op if the supplied
 * generation token does not match the active generation.
 */
export function appendTranscriptCacheRows(generationToken, rows) {
  if (generationToken !== _state.generation) return;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row?.messageId) _state.cache.set(row.messageId, row);
  }
}

/**
 * Finalise an incremental cache stream. Flips `loaded=true` only if
 * the supplied generation token still matches; otherwise leaves the
 * cache state to whichever stream has taken over.
 */
export function finalizeTranscriptCacheStream(generationToken) {
  if (generationToken !== _state.generation) return false;
  _state.loaded = true;
  console.info('[transcriptVault] cache stream finalised', {
    userId: _state.userId,
    size: _state.cache.size,
    generation: _state.generation,
  });
  return true;
}

export function setTranscriptCache(userId, rows) {
  _state.cache.clear();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row?.messageId) _state.cache.set(row.messageId, row);
    }
  }
  _state.loaded = true;
  _state.userId = userId ?? null;
  bumpTranscriptGeneration();
  // Diagnostic: expose runtime status on window for live debugging. Lets us
  // confirm in the console whether the inherited transcript actually landed
  // in memory after a device link.
  if (typeof window !== 'undefined') {
    try {
      window.__hushTranscriptCacheStatus = () => getTranscriptCacheStatus();
      window.__hushTranscriptCacheHas = (messageId) => Boolean(getTranscriptEntry(messageId));
    } catch { /* ignore */ }
  }
  console.info('[transcriptVault] cache populated', {
    userId: _state.userId,
    size: _state.cache.size,
    generation: _state.generation,
  });
}

/**
 * Look up a single transcript entry by server message ID.
 *
 * @param {string} messageId
 * @returns {{messageId: string, plaintext: string, senderId?: string, timestamp: number}|null}
 */
export function getTranscriptEntry(messageId) {
  if (!messageId) return null;
  return _state.cache.get(messageId) ?? null;
}

/**
 * Clear the in-memory transcript cache. Called on vault lock or full logout.
 *
 * Bumps the generation counter so any in-flight async hydrate cannot
 * re-populate the cache after this point.
 */
export function clearTranscriptCache() {
  _state.cache.clear();
  _state.loaded = false;
  _state.userId = null;
  bumpTranscriptGeneration();
}

/**
 * Read-only snapshot of the in-memory transcript cache, used by the OLD
 * device's link-export path so plaintext rows that were decrypted into
 * the runtime cache (but not into MLS `localPlaintext`) are still sealed
 * into the transfer bundle. Returns a freshly-allocated array of
 * shallow-cloned rows: callers must not mutate the cache through the
 * returned references, and the cache must not change shape if a caller
 * later mutates the returned rows.
 *
 * @returns {Array<{messageId: string, plaintext: string, senderId?: string, timestamp: number}>}
 */
export function listTranscriptCacheEntries() {
  const out = [];
  for (const row of _state.cache.values()) {
    if (!row?.messageId) continue;
    const copy = {
      messageId: row.messageId,
      plaintext: row.plaintext,
      timestamp: row.timestamp,
    };
    if (row.senderId !== undefined) copy.senderId = row.senderId;
    if (row.channelId !== undefined) copy.channelId = row.channelId;
    out.push(copy);
  }
  return out;
}

/**
 * @returns {{loaded: boolean, userId: string|null, size: number, generation: number}}
 */
export function getTranscriptCacheStatus() {
  return {
    loaded: _state.loaded,
    userId: _state.userId,
    size: _state.cache.size,
    generation: _state.generation,
  };
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

/**
 * Build an encrypted transcript blob from a raw rows array. Used by the OLD
 * device at link export time after `preDecryptForLinkExport` has populated
 * the active store's localPlaintext.
 *
 * @param {Uint8Array} rootPrivateKey
 * @param {Array<{messageId: string, plaintext: string, senderId?: string, timestamp: number}>} rows
 * @returns {Promise<Uint8Array>}
 */
export async function buildTranscriptBlobForExport(rootPrivateKey, rows, rowsPerFrame) {
  const key = await deriveTranscriptKey(rootPrivateKey);
  // V3 framed: enables the NEW device's import path to consume the
  // transcript ciphertext as a stream of independently-decryptable
  // frames. The at-rest blob format on either device is unchanged.
  return encryptTranscriptBlobFramed(key, rows, rowsPerFrame);
}

/**
 * Decrypt an inbound transcript blob (received via the relay envelope on the
 * NEW device), re-encrypt it with a freshly-random nonce, and persist the
 * re-encrypted bytes into the NEW device's transcript IDB. Returns the
 * decrypted rows so the caller can also seed the in-memory runtime cache
 * for immediate display.
 *
 * @param {{
 *   userId: string,
 *   rootPrivateKey: Uint8Array,
 *   inboundBlob: Uint8Array,
 * }} args
 * @returns {Promise<Array<{messageId: string, plaintext: string, senderId?: string, timestamp: number}>>}
 */
/**
 * Import and re-protect when the NEW-device pipeline already decoded
 * the transcript ciphertext into a rows array (the V3 / streaming
 * path). Same effect as `importAndReprotectTranscriptBlob` minus the
 * inbound-blob decrypt step — saves both the decrypt-whole-blob CPU
 * pass and the gunzipped-JSON-string memory peak.
 *
 * @param {{ userId: string, rootPrivateKey: Uint8Array, rows: Array<object> }} args
 * @returns {Promise<Array<object>>} the same rows that were persisted
 */
export async function importAndReprotectTranscriptRows({ userId, rootPrivateKey, rows, rowsPerFrame }) {
  if (!userId) throw new Error('[transcriptVault] userId is required');
  if (!(rootPrivateKey instanceof Uint8Array)) {
    throw new Error('[transcriptVault] rootPrivateKey must be a Uint8Array');
  }
  if (!Array.isArray(rows)) {
    throw new Error('[transcriptVault] rows must be an array');
  }
  const key = await deriveTranscriptKey(rootPrivateKey);
  // Persist in the V3 framed at-rest format. Re-encryption happens
  // frame-by-frame with a fresh nonce per frame, so the persisted
  // bytes are not bit-for-bit identical to the wire-side ciphertext
  // (preserving the "no relay-side replay surface on disk" property
  // that V2 had).
  const db = await openTranscriptStore(userId);
  try {
    await saveFramedTranscriptAtRest(db, key, rows, rowsPerFrame ?? TRANSCRIPT_AT_REST_DEFAULT_ROWS_PER_FRAME);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return rows;
}

export async function importAndReprotectTranscriptBlob({ userId, rootPrivateKey, inboundBlob }) {
  if (!userId) throw new Error('[transcriptVault] userId is required');
  if (!(rootPrivateKey instanceof Uint8Array)) {
    throw new Error('[transcriptVault] rootPrivateKey must be a Uint8Array');
  }
  if (!(inboundBlob instanceof Uint8Array)) {
    throw new Error('[transcriptVault] inboundBlob must be a Uint8Array');
  }
  const key = await deriveTranscriptKey(rootPrivateKey);
  const rows = await decryptTranscriptBlob(key, inboundBlob);
  // Re-encrypt frame-by-frame into the V3 at-rest format. Each frame
  // gets a fresh nonce so the on-disk bytes are not a bit-for-bit
  // copy of anything that crossed the relay. Lazy-upgrade: any prior
  // V1/V2 'blob' row in the store is cleared by the framed writer's
  // single-tx clear() before the new frames land.
  const db = await openTranscriptStore(userId);
  try {
    await saveFramedTranscriptAtRest(db, key, rows);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return rows;
}

/**
 * Open the transcript IDB, load the persisted blob, decrypt it under the
 * provided root key, and seed the in-memory runtime cache.
 *
 * Called on vault unlock so subsequent `getTranscriptEntry` lookups can
 * serve the inherited transcript without re-decrypting per call.
 *
 * @param {{ userId: string, rootPrivateKey: Uint8Array }} args
 * @returns {Promise<number>} number of rows loaded into the cache
 */
export async function loadTranscriptCacheFromDisk({ userId, rootPrivateKey }) {
  if (!userId || !rootPrivateKey) return 0;
  // Snapshot the generation at start. If the cache is cleared (vault lock)
  // or replaced (eager seed) before we reach a write point, we MUST NOT
  // overwrite it — a stale fire-and-forget hydrate must not re-expose
  // inherited plaintexts after lock.
  const startGen = _state.generation;
  const isStale = () => _state.generation !== startGen;

  const db = await openTranscriptStore(userId);
  let framed = null;
  let blob = null;
  try {
    framed = await loadFramedTranscriptAtRest(db);
    if (!framed) blob = await loadTranscriptBlob(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  if (isStale()) return 0;

  if (!framed && !blob) {
    setTranscriptCache(userId, []);
    return 0;
  }
  const key = await deriveTranscriptKey(rootPrivateKey);
  // Frame-by-frame decode releases each frame's plaintext as soon as
  // its rows are pushed onto the accumulator. The whole-disk blob is
  // never materialised even when the cache hydration runs.
  let rows = framed
    ? await decodeFramedTranscriptAtRest(key, framed.frames)
    : await decryptTranscriptBlob(key, blob);
  if (isStale()) return 0;
  rows = await applyTranscriptForgets(userId, key, rows);
  if (isStale()) return 0;

  setTranscriptCache(userId, rows);
  return rows.length;
}

// Rituals fork (2026-11-05): messages of a Space this person was removed from.
// The at-rest frames can only be rewritten with the vault key, so the ids and
// channels to drop are kept here until the next unlock rewrites the frames
// without them (applyTranscriptForgets); the rewrite clears this row.
const TRANSCRIPT_FORGET_KEY = 'rituals-forget';

/**
 * Rituals fork (2026-11-05): drop a removed Space's messages from the
 * transcript: from the in-memory cache now, and from the encrypted at-rest
 * frames at the next unlock.
 *
 * @param {readonly string[]} messageIds
 * @param {readonly string[]} channelIds - rows carrying one of these channels are dropped too
 * @param {string|null} [userId] - defaults to the user whose transcript is loaded
 * @returns {Promise<number>} cache entries removed
 */
export async function forgetTranscriptEntries(messageIds, channelIds, userId = _state.userId) {
  const ids = new Set(messageIds);
  const channels = new Set(channelIds);
  let removed = 0;
  for (const [id, row] of _state.cache) {
    if (ids.has(id) || (row?.channelId && channels.has(row.channelId))) {
      _state.cache.delete(id);
      ids.add(id);
      removed++;
    }
  }
  if (!userId || (!ids.size && !channels.size)) return removed;
  const db = await openTranscriptStore(userId);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSCRIPT_STORE, 'readwrite');
      const store = tx.objectStore(TRANSCRIPT_STORE);
      const req = store.get(TRANSCRIPT_FORGET_KEY);
      req.onsuccess = () => {
        const prev = req.result?.value ?? {};
        store.put({
          key: TRANSCRIPT_FORGET_KEY,
          value: {
            ids: [...new Set([...(prev.ids ?? []), ...ids])],
            channels: [...new Set([...(prev.channels ?? []), ...channels])],
          },
        });
      };
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return removed;
}

/**
 * Rituals fork (2026-11-05): apply pending forgets to freshly decrypted rows
 * and rewrite the at-rest frames without them (the rewrite clears the
 * pending row).
 *
 * @param {string} userId
 * @param {CryptoKey} key
 * @param {Array<any>} rows
 * @returns {Promise<Array<any>>}
 */
async function applyTranscriptForgets(userId, key, rows) {
  const db = await openTranscriptStore(userId);
  try {
    const pending = await new Promise((resolve, reject) => {
      const req = db.transaction(TRANSCRIPT_STORE, 'readonly').objectStore(TRANSCRIPT_STORE).get(TRANSCRIPT_FORGET_KEY);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
    if (!pending) return rows;
    const ids = new Set(pending.ids ?? []);
    const channels = new Set(pending.channels ?? []);
    const kept = rows.filter((row) => !ids.has(row?.messageId) && !(row?.channelId && channels.has(row.channelId)));
    await saveFramedTranscriptAtRest(db, key, kept);
    return kept;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
