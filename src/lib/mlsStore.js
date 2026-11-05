import { CURRENT_MLS_CIPHERSUITE } from './mlsCiphersuite';

/**
 * MLS Protocol state in IndexedDB (v2).
 * Store prefix: hush-mls-${userId}-${deviceId} (one DB per local user+device).
 *
 * v1 stores: credential, keyPackages, lastResort
 * v2 adds: StorageProvider bridge stores (7) + localPlaintext + groupEpoch
 *
 * window.mlsStorageBridge is initialised after openStore() so the WASM
 * StorageProvider callbacks are available before any group operation.
 */

const DB_NAME_PREFIX = 'hush-mls-';
const HISTORY_DB_NAME_PREFIX = 'hush-mls-history-';
const STORE_CREDENTIAL = 'credential';
const STORE_KEY_PACKAGES = 'keyPackages';
const STORE_LAST_RESORT = 'lastResort';
const STORE_PROTOCOL_META = 'protocolMeta';
const DB_VERSION = 5;

const CREDENTIAL_KEY = 'credential';
const LAST_RESORT_KEY = 'lastResort';
const CIPHERSUITE_META_KEY = 'currentMlsCiphersuite';

// ---------------------------------------------------------------------------
// StorageProvider bridge stores
// Names must match the constants in hush-crypto/src/storage_bridge.rs.
// ---------------------------------------------------------------------------

// Complete list of object stores used by OpenMLS WASM StorageProvider.
// Extracted from hush_crypto_bg.wasm binary - must match exactly.
const STORAGE_PROVIDER_STORES = [
  'mls_confirmation_tag',
  'mls_encryption_key_pairs',
  'mls_encryption_keys',
  'mls_epoch_key_pairs',
  'mls_epoch_secrets',
  'mls_group_context',
  'mls_group_state',
  'mls_groups',
  'mls_interim_transcript_hash',
  'mls_join_config',
  'mls_key_packages',
  'mls_message_secrets',
  'mls_own_leaf_index',
  'mls_own_leaf_nodes',
  'mls_proposal_queue_refs',
  'mls_proposals',
  'mls_psk',
  'mls_queued_proposals',
  'mls_resumption_psk',
  'mls_signature_key_pairs',
  'mls_tree_sync',
];

// localPlaintext is intentionally NOT part of the MLS history snapshot.
// Cross-device transfer of decrypted message plaintexts goes through the
// transcriptVault's encrypted blob (see lib/transcriptVault.js); shipping
// plaintext rows in the snapshot would put naked transcript data on the
// wire (modulo the relay envelope) and at rest on the new device.
//
// Rituals fork (2026-11-05): the snapshot carries no MLS key material at all.
// The credential store holds the MLS signing private key; the OpenMLS stores
// hold the approving device's signature keys, own leaf, leaf HPKE keys,
// epoch key pairs, unused KeyPackage private keys and epoch/message secrets.
// A linked device makes its own MLS identity and joins groups itself, and the
// history tier only ever reads `localPlaintext` (useMLS getCachedMessage);
// plaintext history travels in the transcriptVault blob. Copying any of these
// would let a revoked or compromised linked device keep decrypting for, or
// signing as, the approving device's leaf.
export const HISTORY_SNAPSHOT_EXCLUDED_STORES = Object.freeze([
  STORE_CREDENTIAL,
  ...STORAGE_PROVIDER_STORES,
]);

const HISTORY_SNAPSHOT_STORES = [
  STORE_CREDENTIAL,
  ...STORAGE_PROVIDER_STORES,
  'groupEpoch',
].filter((storeName) => !HISTORY_SNAPSHOT_EXCLUDED_STORES.includes(storeName));

const CIPHERSUITE_SCOPED_STORES = [
  STORE_KEY_PACKAGES,
  STORE_LAST_RESORT,
  ...STORAGE_PROVIDER_STORES,
  'groupEpoch',
];

// Synchronous Map cache backed by IndexedDB. WASM reads/writes happen synchronously
// against this cache. The cache is populated by preloadGroupState() before WASM calls
// and flushed back to IDB by writeBytes() fire-and-forget writes.
const storageCache = new Map(); // key: `${storeName}:${hexKey}`, value: Uint8Array

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a Uint8Array (or iterable of bytes) to a lowercase hex string.
 * @param {Uint8Array|number[]} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// StorageProvider bridge - initialised once after openStore()
// ---------------------------------------------------------------------------

/**
 * Initialises window.mlsStorageBridge with synchronous read/write/delete
 * operations backed by the in-memory storageCache. Each write is also
 * fire-and-forget persisted to IndexedDB.
 *
 * Called internally by openStore() after the DB is open.
 *
 * @param {IDBDatabase} db
 */
function initStorageBridge(db) {
  window.mlsStorageBridge = {
    /**
     * Write bytes for a key in a named store.
     * @param {string} storeName
     * @param {Uint8Array} keyBytes
     * @param {Uint8Array} valueBytes
     */
    writeBytes(storeName, keyBytes, valueBytes) {
      const hexKey = bytesToHex(keyBytes);
      const cacheKey = `${storeName}:${hexKey}`;
      storageCache.set(cacheKey, new Uint8Array(valueBytes));
      // Fire-and-forget persistence - correctness relies on preloadGroupState before WASM calls.
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put({ key: hexKey, value: Array.from(valueBytes) });
      } catch (err) {
        console.warn('[mlsStore] writeBytes IDB write failed for', storeName, hexKey, err);
      }
    },

    /**
     * Read bytes for a key. Returns Uint8Array from cache or null if not found.
     * Synchronous - preloadGroupState() must be called first.
     * @param {string} storeName
     * @param {Uint8Array} keyBytes
     * @returns {Uint8Array|null}
     */
    readBytes(storeName, keyBytes) {
      const hexKey = bytesToHex(keyBytes);
      const cacheKey = `${storeName}:${hexKey}`;
      return storageCache.get(cacheKey) ?? null;
    },

    /**
     * Delete a key from the store.
     * @param {string} storeName
     * @param {Uint8Array} keyBytes
     */
    deleteBytes(storeName, keyBytes) {
      const hexKey = bytesToHex(keyBytes);
      const cacheKey = `${storeName}:${hexKey}`;
      storageCache.delete(cacheKey);
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(hexKey);
      } catch (err) {
        console.warn('[mlsStore] deleteBytes IDB delete failed for', storeName, hexKey, err);
      }
    },

    /**
     * Read a list of byte blobs stored under a key.
     * Returns an array of Uint8Arrays (may be empty).
     * @param {string} storeName
     * @param {Uint8Array} keyBytes
     * @returns {Uint8Array[]}
     */
    readList(storeName, keyBytes) {
      const hexKey = bytesToHex(keyBytes);
      const listCacheKey = `${storeName}:list:${hexKey}`;
      const raw = storageCache.get(listCacheKey);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(new TextDecoder().decode(raw));
        return parsed.map((item) => new Uint8Array(item));
      } catch {
        return [];
      }
    },

    /**
     * Append a byte blob to a list stored under a key.
     * @param {string} storeName
     * @param {Uint8Array} keyBytes
     * @param {Uint8Array} valueBytes
     */
    appendToList(storeName, keyBytes, valueBytes) {
      const hexKey = bytesToHex(keyBytes);
      const listCacheKey = `${storeName}:list:${hexKey}`;
      const existing = window.mlsStorageBridge.readList(storeName, keyBytes);
      existing.push(new Uint8Array(valueBytes));
      const encoded = new TextEncoder().encode(JSON.stringify(existing.map((u8) => Array.from(u8))));
      storageCache.set(listCacheKey, encoded);
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put({ key: `list:${hexKey}`, value: Array.from(encoded) });
      } catch (err) {
        console.warn('[mlsStore] appendToList IDB write failed for', storeName, hexKey, err);
      }
    },

    /**
     * Remove a specific byte blob from a list stored under a key.
     * @param {string} storeName
     * @param {Uint8Array} keyBytes
     * @param {Uint8Array} valueBytes
     */
    removeFromList(storeName, keyBytes, valueBytes) {
      const hexKey = bytesToHex(keyBytes);
      const listCacheKey = `${storeName}:list:${hexKey}`;
      const existing = window.mlsStorageBridge.readList(storeName, keyBytes);
      const targetHex = bytesToHex(valueBytes);
      const filtered = existing.filter((u8) => bytesToHex(u8) !== targetHex);
      const encoded = new TextEncoder().encode(JSON.stringify(filtered.map((u8) => Array.from(u8))));
      storageCache.set(listCacheKey, encoded);
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put({ key: `list:${hexKey}`, value: Array.from(encoded) });
      } catch (err) {
        console.warn('[mlsStore] removeFromList IDB write failed for', storeName, hexKey, err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// DB open / upgrade
// ---------------------------------------------------------------------------

/**
 * Opens the MLS store for the given user and device.
 * Upgrades from v1 -> v2 by adding new object stores without recreating v1 stores.
 * Initialises window.mlsStorageBridge after the DB is open.
 *
 * @param {string} userId - Local user ID (UUID)
 * @param {string} deviceId - Local device ID
 * @param {{ initBridge?: boolean }} [options]
 * @returns {Promise<IDBDatabase>}
 */
function openStoreWithPrefix(dbNamePrefix, userId, deviceId, options = {}) {
  const { initBridge = true } = options;
  const dbName = `${dbNamePrefix}${userId}-${deviceId}`;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      (async () => {
        try {
          if (dbNamePrefix === DB_NAME_PREFIX) {
            await ensureCurrentCiphersuite(db);
          }
          if (initBridge) {
            initStorageBridge(db);
          }
          // Request persistent storage so iOS WKWebView doesn't evict MLS state.
          navigator.storage?.persist?.().catch(() => {});
          resolve(db);
        } catch (err) {
          db.close();
          reject(err);
        }
      })();
    };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // v1 stores - create only if absent (handles fresh installs and upgrades).
      if (!db.objectStoreNames.contains(STORE_CREDENTIAL)) {
        db.createObjectStore(STORE_CREDENTIAL, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_KEY_PACKAGES)) {
        db.createObjectStore(STORE_KEY_PACKAGES, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_LAST_RESORT)) {
        db.createObjectStore(STORE_LAST_RESORT, { keyPath: 'key' });
      }

      // v2 stores - added in version 2.
      for (const storeName of STORAGE_PROVIDER_STORES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'key' });
        }
      }
      if (!db.objectStoreNames.contains('localPlaintext')) {
        db.createObjectStore('localPlaintext', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('groupEpoch')) {
        db.createObjectStore('groupEpoch', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_PROTOCOL_META)) {
        db.createObjectStore(STORE_PROTOCOL_META, { keyPath: 'key' });
      }
    };
  });
}

export function openStore(userId, deviceId) {
  return openStoreWithPrefix(DB_NAME_PREFIX, userId, deviceId);
}

/**
 * Opens the read-only history fallback MLS store imported from another device.
 *
 * This store is never used for active group operations; it only exists so the
 * new device can decrypt pre-link history while its own MLS identity handles
 * future traffic.
 *
 * It intentionally does not rebind the global MLS StorageProvider bridge.
 * History reads use preloadGroupState() against this DB, while active group
 * operations must continue using the primary store's bridge.
 *
 * @param {string} userId
 * @param {string} deviceId
 * @returns {Promise<IDBDatabase>}
 */
export function openHistoryStore(userId, deviceId) {
  return openStoreWithPrefix(HISTORY_DB_NAME_PREFIX, userId, deviceId, { initBridge: false });
}

/**
 * Ensures active MLS state belongs to the client's current ciphersuite.
 *
 * A server-side ciphersuite migration creates fresh GroupInfo / commit /
 * KeyPackage rows under the new suite, but the browser's IndexedDB can still
 * contain old OpenMLS group state keyed only by channel UUID. Reusing that
 * state makes the client skip the new-suite join and later fail with
 * `ValidationError(WrongEpoch)`. On suite mismatch we clear only suite-scoped
 * MLS material and preserve identity credentials plus plaintext transcript
 * cache.
 *
 * @param {IDBDatabase} db
 * @param {number} [currentCiphersuite]
 * @returns {Promise<boolean>} true when suite-scoped state was reset
 */
export async function ensureCurrentCiphersuite(db, currentCiphersuite = CURRENT_MLS_CIPHERSUITE) {
  const row = await get(db, STORE_PROTOCOL_META, CIPHERSUITE_META_KEY);
  if (row?.ciphersuite === currentCiphersuite) {
    return false;
  }

  storageCache.clear();
  for (const storeName of CIPHERSUITE_SCOPED_STORES) {
    if (db.objectStoreNames.contains(storeName)) {
      await clearStore(db, storeName);
    }
  }
  await put(db, STORE_PROTOCOL_META, CIPHERSUITE_META_KEY, {
    ciphersuite: currentCiphersuite,
    updatedAt: Date.now(),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Instance namespace helpers
// ---------------------------------------------------------------------------

/**
 * Returns a storage key namespaced by instance to prevent cross-instance
 * UUID collisions (Pitfall 3: two instances can have channels with the same UUID).
 *
 * Falls back to the bare channelId when instanceUrl is not provided so that
 * existing single-instance callers continue to work without changes.
 *
 * @param {string|null|undefined} instanceUrl - Canonical instance base URL
 * @param {string} channelId - Channel UUID (or any composite key like "voice:uuid")
 * @returns {string}
 */
export function namespacedKey(instanceUrl, channelId) {
  if (!instanceUrl) return channelId;
  try {
    const host = new URL(instanceUrl).host;
    return `${host}:${channelId}`;
  } catch {
    // If the URL is malformed, fall back to bare key rather than throwing.
    return channelId;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<void>}
 */
function put(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put({ ...value, key });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<unknown|null>}
 */
function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<void>}
 */
function del(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Returns all records from an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<Array<{ key: string, value: number[] }>>}
 */
function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Clears an object store.
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<void>}
 */
function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Writes a raw row into an object store. The row must include its `key`.
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {object} row
 * @returns {Promise<void>}
 */
function putRawRow(db, storeName, row) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// StorageProvider cache management
// ---------------------------------------------------------------------------

/**
 * Preloads all StorageProvider store entries from IndexedDB into the sync cache.
 * Must be called before any WASM group operation to ensure synchronous reads succeed.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<void>}
 */
export async function preloadGroupState(db) {
  for (const storeName of STORAGE_PROVIDER_STORES) {
    const rows = await getAll(db, storeName);
    for (const row of rows) {
      const cacheKey = `${storeName}:${row.key}`;
      // Only populate from IDB if the cache doesn't already have a newer entry.
      // writeBytes() updates the cache synchronously but its IDB transaction may
      // not have committed yet - clobbering the cache with stale IDB data was the
      // root cause of "Group not found" after createGroup.
      if (!storageCache.has(cacheKey)) {
        storageCache.set(cacheKey, new Uint8Array(row.value));
      }
    }
  }
}

/**
 * Runs a read-only callback with the storage cache temporarily scoped to a
 * history DB.
 *
 * The active cache is saved, cleared, the history DB's group state is preloaded,
 * the callback runs, and then the active cache is restored. This ensures WASM
 * MLS reads inside the callback see only data from the history DB, not stale
 * entries left by the active store's preloadGroupState().
 *
 * This helper is ONLY safe for read-only MLS export/derivation operations.
 * Without it, preloadGroupState(historyDb) silently skips keys that are already
 * present in the shared cache from the active store, causing history operations
 * to read active-store state instead.
 *
 * NOTE: The global window.mlsStorageBridge is still bound to the active DB's
 * IDB handle. Any fire-and-forget writes the WASM StorageProvider makes during
 * the callback will land in the active DB. Because of that, this helper MUST
 * NOT be used for stateful operations like message processing or commit
 * application. The primary goal is cache-read correctness for history-backed
 * export/derivation operations.
 *
 * @param {IDBDatabase} historyDb - Opened history store DB
 * @param {(db: IDBDatabase) => Promise<T>} fn - Read-only callback
 * @returns {Promise<T>}
 * @template T
 */
export async function withReadOnlyHistoryScope(historyDb, fn) {
  const saved = new Map(storageCache);
  storageCache.clear();
  try {
    await preloadGroupState(historyDb);
    return await fn(historyDb);
  } finally {
    storageCache.clear();
    for (const [k, v] of saved) storageCache.set(k, v);
  }
}

/**
 * Exports the subset of MLS state needed to decrypt pre-link history on a new
 * device. KeyPackages and last-resort material are intentionally excluded
 * because the imported store is read-only history fallback, not an active
 * sending identity.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<{ version: number, stores: Record<string, Array<object>> }>}
 */
export async function exportHistorySnapshot(db) {
  const stores = {};
  for (const storeName of HISTORY_SNAPSHOT_STORES) {
    stores[storeName] = await getAll(db, storeName);
  }
  return {
    version: 1,
    stores,
  };
}

/**
 * Imports a history snapshot into a read-only fallback store.
 *
 * Existing contents are replaced store-by-store so a regenerated device link
 * does not accumulate stale group state.
 *
 * @param {IDBDatabase} db
 * @param {{ stores?: Record<string, Array<object>> }|null} snapshot
 * @returns {Promise<void>}
 */
export async function importHistorySnapshot(db, snapshot) {
  if (!snapshot?.stores) return;

  // Defensive: a snapshot from an older approving device may still carry the
  // excluded key-material stores. Clear them and never import their rows.
  for (const storeName of HISTORY_SNAPSHOT_EXCLUDED_STORES) {
    await clearStore(db, storeName);
  }
  for (const storeName of HISTORY_SNAPSHOT_STORES) {
    await clearStore(db, storeName);
    const rows = Array.isArray(snapshot.stores[storeName])
      ? snapshot.stores[storeName]
      : [];
    for (const row of rows) {
      await putRawRow(db, storeName, row);
    }
  }
}

/**
 * Flush the entire sync cache back to IndexedDB for all StorageProvider stores.
 * Called after WASM operations to ensure durability before the next page load.
 *
 * In normal operation the fire-and-forget writes in writeBytes() handle durability.
 * This explicit flush is a belt-and-suspenders call after operations that mutate state.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<void>}
 */
export async function flushStorageCache(db) {
  for (const [cacheKey, value] of storageCache) {
    const colonIdx = cacheKey.indexOf(':');
    if (colonIdx < 0) continue;
    const storeName = cacheKey.slice(0, colonIdx);
    const hexKey = cacheKey.slice(colonIdx + 1);
    if (!STORAGE_PROVIDER_STORES.includes(storeName)) continue;
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ key: hexKey, value: Array.from(value) });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Best-effort - individual store may not exist for older DBs during upgrade.
    }
  }
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/**
 * Retrieve the stored MLS credential. Returns null if not yet generated.
 * @param {IDBDatabase} db
 * @returns {Promise<{ signingPublicKey: Uint8Array, signingPrivateKey: Uint8Array, credentialBytes: Uint8Array }|null>}
 */
export async function getCredential(db) {
  const row = await get(db, STORE_CREDENTIAL, CREDENTIAL_KEY);
  if (!row?.signingPublicKey) return null;
  return {
    signingPublicKey: new Uint8Array(row.signingPublicKey),
    signingPrivateKey: new Uint8Array(row.signingPrivateKey),
    credentialBytes: new Uint8Array(row.credentialBytes),
  };
}

/**
 * Store the MLS credential. Bytes are serialised as number arrays for IndexedDB compat.
 * @param {IDBDatabase} db
 * @param {{ signingPublicKey: Uint8Array, signingPrivateKey: Uint8Array, credentialBytes: Uint8Array }} credential
 * @returns {Promise<void>}
 */
export async function setCredential(db, credential) {
  await put(db, STORE_CREDENTIAL, CREDENTIAL_KEY, {
    signingPublicKey: Array.from(credential.signingPublicKey),
    signingPrivateKey: Array.from(credential.signingPrivateKey),
    credentialBytes: Array.from(credential.credentialBytes),
  });
}

// ---------------------------------------------------------------------------
// KeyPackage private key blobs
// ---------------------------------------------------------------------------

/**
 * Retrieve a KeyPackage private key blob by its hashRefHex.
 * @param {IDBDatabase} db
 * @param {string} hashRefHex - Hex-encoded KeyPackage hash reference
 * @returns {Promise<{ keyPackageBytes: Uint8Array, privateKeyBytes: Uint8Array, createdAt: number }|null>}
 */
export async function getKeyPackage(db, hashRefHex) {
  const row = await get(db, STORE_KEY_PACKAGES, hashRefHex);
  if (!row?.keyPackageBytes) return null;
  return {
    keyPackageBytes: new Uint8Array(row.keyPackageBytes),
    privateKeyBytes: new Uint8Array(row.privateKeyBytes),
    createdAt: row.createdAt ?? 0,
  };
}

/**
 * Store a KeyPackage private key blob.
 * @param {IDBDatabase} db
 * @param {string} hashRefHex - Hex-encoded KeyPackage hash reference (IndexedDB key)
 * @param {{ keyPackageBytes: Uint8Array, privateKeyBytes: Uint8Array, createdAt: number }} payload
 * @returns {Promise<void>}
 */
export async function setKeyPackage(db, hashRefHex, payload) {
  await put(db, STORE_KEY_PACKAGES, hashRefHex, {
    keyPackageBytes: Array.from(payload.keyPackageBytes),
    privateKeyBytes: Array.from(payload.privateKeyBytes),
    createdAt: payload.createdAt ?? Date.now(),
  });
}

/**
 * Delete a consumed KeyPackage private key blob (forward secrecy).
 * @param {IDBDatabase} db
 * @param {string} hashRefHex
 * @returns {Promise<void>}
 */
export async function deleteKeyPackage(db, hashRefHex) {
  await del(db, STORE_KEY_PACKAGES, hashRefHex);
}

/**
 * List all stored KeyPackage blobs. Used for debugging and maintenance.
 * @param {IDBDatabase} db
 * @returns {Promise<Array<object>>}
 */
export function listAllKeyPackages(db) {
  return getAll(db, STORE_KEY_PACKAGES);
}

// ---------------------------------------------------------------------------
// Last-resort KeyPackage
// ---------------------------------------------------------------------------

/**
 * Retrieve the last-resort KeyPackage. Returns null if not yet stored.
 * The last-resort KeyPackage is never consumed - it serves as a read-only fallback
 * when all regular KeyPackages have been exhausted.
 * @param {IDBDatabase} db
 * @returns {Promise<{ keyPackageBytes: Uint8Array, privateKeyBytes: Uint8Array, hashRefHex: string }|null>}
 */
export async function getLastResort(db) {
  const row = await get(db, STORE_LAST_RESORT, LAST_RESORT_KEY);
  if (!row?.keyPackageBytes) return null;
  return {
    keyPackageBytes: new Uint8Array(row.keyPackageBytes),
    privateKeyBytes: new Uint8Array(row.privateKeyBytes),
    hashRefHex: row.hashRefHex,
  };
}

/**
 * Store the last-resort KeyPackage (replacing any previous entry).
 * @param {IDBDatabase} db
 * @param {{ keyPackageBytes: Uint8Array, privateKeyBytes: Uint8Array, hashRefHex: string }} payload
 * @returns {Promise<void>}
 */
export async function setLastResort(db, payload) {
  await put(db, STORE_LAST_RESORT, LAST_RESORT_KEY, {
    keyPackageBytes: Array.from(payload.keyPackageBytes),
    privateKeyBytes: Array.from(payload.privateKeyBytes),
    hashRefHex: payload.hashRefHex,
  });
}

// ---------------------------------------------------------------------------
// Local plaintext cache - self-sent messages
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached plaintext entry for a message.
 *
 * Originally used only to recover own sent messages (MLS-encrypted for others,
 * not self). The schema was extended with an optional `senderId` so the same
 * cache can also hold plaintexts pre-decrypted at link time on a new linked
 * device, where the sender is not necessarily the current user.
 *
 * @param {IDBDatabase} db
 * @param {string} messageId - Server-assigned message UUID
 * @returns {Promise<{ plaintext: string, timestamp: number, senderId?: string }|null>}
 */
export async function getLocalPlaintext(db, messageId) {
  const row = await get(db, 'localPlaintext', messageId);
  if (!row?.plaintext) return null;
  return {
    plaintext: row.plaintext,
    timestamp: row.timestamp ?? 0,
    ...(row.senderId ? { senderId: row.senderId } : {}),
  };
}

/**
 * Store a plaintext entry for a self-sent message OR a pre-decrypted legacy
 * message. `senderId` is optional and only set for non-self entries written
 * by the link-time legacy pre-decrypt path; existing self-send writes omit
 * it because the sender is implicitly the current user.
 *
 * @param {IDBDatabase} db
 * @param {string} messageId
 * @param {{ plaintext: string, timestamp: number, senderId?: string }} payload
 * @returns {Promise<void>}
 */
export async function setLocalPlaintext(db, messageId, payload) {
  const row = {
    plaintext: payload.plaintext,
    timestamp: payload.timestamp ?? Date.now(),
  };
  if (payload.senderId) row.senderId = payload.senderId;
  await put(db, 'localPlaintext', messageId, row);
}

/**
 * Read every entry in the localPlaintext store. Used by the link-export
 * pipeline to harvest all rows for the encrypted transcript blob.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<Array<{ messageId: string, plaintext: string, senderId?: string, timestamp: number }>>}
 */
export async function listAllLocalPlaintexts(db) {
  const rows = await getAll(db, 'localPlaintext');
  return rows
    .filter((r) => r && typeof r.plaintext === 'string')
    .map((r) => ({
      messageId: r.key,
      plaintext: r.plaintext,
      timestamp: r.timestamp ?? 0,
      ...(r.senderId ? { senderId: r.senderId } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Group epoch tracking - catchup on reconnect
// ---------------------------------------------------------------------------

/**
 * Get the last known epoch for a channel's MLS group.
 * Returns null if the group has not been joined yet.
 *
 * @param {IDBDatabase} db
 * @param {string} channelId - Channel UUID (or composite key like "voice:uuid", "guild-meta:uuid")
 * @param {string} [instanceUrl] - Instance base URL for namespacing (optional - defaults to no namespace)
 * @returns {Promise<number|null>}
 */
export async function getGroupEpoch(db, channelId, instanceUrl) {
  const key = namespacedKey(instanceUrl, channelId);
  const row = await get(db, 'groupEpoch', key);
  if (row == null || row.epoch == null) return null;
  return row.epoch;
}

/**
 * Update the last known epoch for a channel's MLS group.
 * @param {IDBDatabase} db
 * @param {string} channelId
 * @param {number} epoch
 * @param {string} [instanceUrl] - Instance base URL for namespacing (optional)
 * @returns {Promise<void>}
 */
export async function setGroupEpoch(db, channelId, epoch, instanceUrl) {
  const key = namespacedKey(instanceUrl, channelId);
  await put(db, 'groupEpoch', key, { epoch });
}

/**
 * Delete the epoch record for a channel (used when leaving a group).
 * @param {IDBDatabase} db
 * @param {string} channelId
 * @param {string} [instanceUrl] - Instance base URL for namespacing (optional)
 * @returns {Promise<void>}
 */
export async function deleteGroupEpoch(db, channelId, instanceUrl) {
  const key = namespacedKey(instanceUrl, channelId);
  await del(db, 'groupEpoch', key);
}

/**
 * List all tracked channel epoch records.
 * Returns array of { key: channelId, epoch: number }.
 * Used by the self-update timer to iterate all joined groups.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<Array<{ key: string, epoch: number }>>}
 */
export async function listAllGroupEpochs(db) {
  return getAll(db, 'groupEpoch');
}
