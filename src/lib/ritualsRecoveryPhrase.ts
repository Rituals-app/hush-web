/**
 * Keeps an auto-created identity's recovery phrase on this device until the
 * person saves it (Rituals fork, 2026-11-05).
 *
 * A Rituals space entry creates the identity with no input: the 12 words are
 * generated in this browser and never shown at that moment. The identity key
 * is derived one-way from the words (BIP39 seed → first 32 bytes), so the
 * words cannot be rebuilt from the unlocked identity later. To offer "Save
 * recovery phrase" in Settings, the words are sealed here under a
 * non-extractable AES-GCM key held in IndexedDB, the same protection the
 * `never` vault-timeout policy already gives the identity key itself
 * (`src/lib/vaultSessionKey.ts`). The record is deleted when the person
 * confirms they saved the words, on sign-out and on device revocation.
 *
 * The database name starts with `hush-` and contains the user id so the
 * revoked-device sweep in `useAuth` also removes it.
 */

const DB_PREFIX = "hush-rituals-recovery-"
const STORE = "phrase"
const RECORD = "current"
const IV_BYTES = 12

interface PhraseRecord {
  cryptoKey: CryptoKey
  iv: Uint8Array
  ciphertext: Uint8Array
  createdAt: number
}

export function recoveryPhraseDatabaseName(userId: string): string {
  return `${DB_PREFIX}${userId}`
}

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(recoveryPhraseDatabaseName(userId), 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("open recovery store failed"))
  })
}

function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest | null
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE, mode)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let result: T | null = null
    const req = body(tx.objectStore(STORE))
    if (req) {
      req.onsuccess = () => {
        result = (req.result as T | undefined) ?? null
      }
    }
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error ?? new Error("recovery store tx failed"))
    tx.onabort = () => reject(tx.error ?? new Error("recovery store tx aborted"))
  })
}

/** Seals the phrase for `userId`, replacing any earlier copy. */
export async function storeRecoveryPhrase(userId: string, phrase: string): Promise<void> {
  if (!userId || !phrase) return
  const cryptoKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      cryptoKey,
      new TextEncoder().encode(phrase) as BufferSource
    )
  )
  const db = await openDb(userId)
  try {
    const record: PhraseRecord = { cryptoKey, iv, ciphertext, createdAt: Date.now() }
    await runTx(db, "readwrite", (store) => store.put(record, RECORD))
  } finally {
    db.close()
  }
}

/** Returns the kept phrase, or null when none is kept on this device. */
export async function readRecoveryPhrase(userId: string): Promise<string | null> {
  if (!userId || typeof indexedDB === "undefined") return null
  let db: IDBDatabase | null = null
  try {
    db = await openDb(userId)
    const record = await runTx<PhraseRecord>(db, "readonly", (store) => store.get(RECORD))
    if (!record?.cryptoKey || !record.iv || !record.ciphertext) return null
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv as BufferSource },
      record.cryptoKey,
      record.ciphertext as BufferSource
    )
    const phrase = new TextDecoder().decode(plain).trim()
    return phrase.split(/\s+/).length >= 12 ? phrase : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/** Deletes the kept phrase (after the person saved it, or on sign-out). */
export function deleteRecoveryPhrase(userId: string): Promise<void> {
  if (!userId || typeof indexedDB === "undefined") return Promise.resolve()
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(recoveryPhraseDatabaseName(userId))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
