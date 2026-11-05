/**
 * Rituals fork (2026-11-05): storage check for the rituals.app frame.
 *
 * The framed client is the web home of the Space identity: it boots, creates
 * or links its identity inside the frame whatever the engine's partitioning
 * (Spike 1: Chromium and Firefox share every store with a same-site frame;
 * WebKit shares cookies and localStorage but partitions IndexedDB, which then
 * simply makes the frame "this browser" as one more device). So nothing here
 * looks at document.hasStorageAccess(), and requestStorageAccess() is never
 * called: in WebKit it resolves and flips the flag without un-partitioning
 * IndexedDB.
 *
 * The only reason not to boot is storage that does not work at all (private
 * mode in some engines, storage blocked): IndexedDB, where the identity vault
 * and MLS state live, cannot be opened or written, or localStorage, where the
 * device id and tokens live, throws. Then the frame posts
 * `{type:"storage-unavailable", reason}` instead of booting.
 */

const CHECK_DB = 'rituals-space-storage-check';
const CHECK_STORE = 'kv';
const CHECK_KEY = 'check';
const LOCAL_KEY = 'rituals_space_storage_check';
const IDB_TIMEOUT_MS = 5000;

/**
 * @typedef {'localstorage_unavailable'|'indexeddb_unavailable'|'indexeddb_write_failed'} StorageReason
 * @param {{ localStorageOk: boolean, idbOpened: boolean, idbWritten: boolean }} facts
 * @returns {{ usable: boolean, reason: StorageReason|null }}
 */
export function decideFrameStorage({ localStorageOk, idbOpened, idbWritten }) {
  if (!localStorageOk) return { usable: false, reason: 'localstorage_unavailable' };
  if (!idbOpened) return { usable: false, reason: 'indexeddb_unavailable' };
  if (!idbWritten) return { usable: false, reason: 'indexeddb_write_failed' };
  return { usable: true, reason: null };
}

function checkLocalStorage() {
  try {
    window.localStorage.setItem(LOCAL_KEY, '1');
    const ok = window.localStorage.getItem(LOCAL_KEY) === '1';
    window.localStorage.removeItem(LOCAL_KEY);
    return ok;
  } catch {
    return false;
  }
}

function withTimeout(promise, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), IDB_TIMEOUT_MS);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function openCheckDb() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(CHECK_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CHECK_STORE)) request.result.createObjectStore(CHECK_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Writes, reads back and deletes one value. */
function writeCheck(db) {
  return new Promise((resolve) => {
    try {
      const value = String(Date.now());
      const tx = db.transaction(CHECK_STORE, 'readwrite');
      const store = tx.objectStore(CHECK_STORE);
      store.put(value, CHECK_KEY);
      const read = store.get(CHECK_KEY);
      let matched = false;
      read.onsuccess = () => {
        matched = read.result === value;
        store.delete(CHECK_KEY);
      };
      tx.oncomplete = () => resolve(matched);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Framed pages only, before any identity work. Touches nothing of the
 * identity: one localStorage key and one small database, both cleaned up.
 *
 * @returns {Promise<{ usable: boolean, reason: StorageReason|null }>}
 */
export async function checkFrameStorage() {
  const localStorageOk = checkLocalStorage();
  let idbOpened = false;
  let idbWritten = false;
  if (typeof indexedDB !== 'undefined') {
    const db = await withTimeout(openCheckDb(), null);
    if (db) {
      idbOpened = true;
      idbWritten = await withTimeout(writeCheck(db), false);
      try {
        db.close();
      } catch {
        // Already closed.
      }
    }
  }
  return decideFrameStorage({ localStorageOk, idbOpened, idbWritten });
}
