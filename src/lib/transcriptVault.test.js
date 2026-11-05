/**
 * Tests for transcriptVault.js — encrypted transcript-cache transfer + at-rest store.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  deriveTranscriptKey,
  encryptTranscriptBlob,
  decryptTranscriptBlob,
  openTranscriptStore,
  saveTranscriptBlob,
  loadTranscriptBlob,
  deleteTranscriptDatabase,
  setTranscriptCache,
  getTranscriptEntry,
  clearTranscriptCache,
  getTranscriptCacheStatus,
  listTranscriptCacheEntries,
  buildTranscriptBlobForExport,
  importAndReprotectTranscriptBlob,
  loadTranscriptCacheFromDisk,
} from './transcriptVault';

let userCounter = 0;
function nextUserId() {
  userCounter += 1;
  return `user-${userCounter}-${Date.now()}`;
}

const ROOT_KEY_A = new Uint8Array(32).fill(0xa5);
const ROOT_KEY_B = new Uint8Array(32).fill(0x42);

const SAMPLE_ROWS = [
  { messageId: 'm1', plaintext: 'hello', senderId: 'alice', timestamp: 1000 },
  { messageId: 'm2', plaintext: 'goodbye', senderId: 'bob', timestamp: 2000 },
  { messageId: 'm3', plaintext: 'self note', timestamp: 3000 },
];

describe('transcriptVault — key derivation', () => {
  it('derives the same key for the same root identity', async () => {
    const k1 = await deriveTranscriptKey(ROOT_KEY_A);
    const k2 = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlob(k1, SAMPLE_ROWS);
    const rows = await decryptTranscriptBlob(k2, blob);
    expect(rows).toEqual(SAMPLE_ROWS);
  });

  it('derives a different key for a different root identity', async () => {
    const ka = await deriveTranscriptKey(ROOT_KEY_A);
    const kb = await deriveTranscriptKey(ROOT_KEY_B);
    const blob = await encryptTranscriptBlob(ka, SAMPLE_ROWS);
    await expect(decryptTranscriptBlob(kb, blob)).rejects.toBeDefined();
  });

  it('rejects an empty private key', async () => {
    await expect(deriveTranscriptKey(new Uint8Array(0))).rejects.toThrow(/non-empty/);
  });
});

describe('transcriptVault — encrypt/decrypt round-trip', () => {
  it('round-trips an array of rows including optional senderId', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    expect(blob.byteLength).toBeGreaterThan(12);
    const rows = await decryptTranscriptBlob(key, blob);
    expect(rows).toEqual(SAMPLE_ROWS);
  });

  it('compresses repetitive transcript payloads before encryption', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const repetitiveRows = Array.from({ length: 200 }, (_, index) => ({
      messageId: `m-${index}`,
      plaintext: 'hello world '.repeat(80),
      senderId: 'alice',
      timestamp: index,
    }));
    const rawPayloadBytes = new TextEncoder().encode(JSON.stringify({ v: 2, rows: repetitiveRows }));

    const blob = await encryptTranscriptBlob(key, repetitiveRows);
    // nonce + ciphertext should stay materially below the raw JSON payload for
    // repetitive human text, otherwise the device-link 413 problem remains.
    expect(blob.byteLength).toBeLessThan(rawPayloadBytes.byteLength / 2);
    const rows = await decryptTranscriptBlob(key, blob);
    expect(rows).toEqual(repetitiveRows);
  });

  it('round-trips an empty rows array', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlob(key, []);
    const rows = await decryptTranscriptBlob(key, blob);
    expect(rows).toEqual([]);
  });

  it('produces a different ciphertext on each call (fresh nonce)', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const a = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    const b = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('rejects a tampered blob', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    blob[blob.length - 1] ^= 0xff;
    await expect(decryptTranscriptBlob(key, blob)).rejects.toBeDefined();
  });

  it('rejects a blob shorter than the nonce', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    await expect(decryptTranscriptBlob(key, new Uint8Array(5))).rejects.toThrow(/invalid/);
  });

  it('decrypts legacy v1 blobs that stored raw JSON plaintext', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, rows: SAMPLE_ROWS }));
    const nonce = new Uint8Array(12).fill(7);
    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, payload);
    const ciphertext = new Uint8Array(ciphertextBuf);
    const legacyBlob = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    legacyBlob.set(nonce, 0);
    legacyBlob.set(ciphertext, nonce.byteLength);

    const rows = await decryptTranscriptBlob(key, legacyBlob);
    expect(rows).toEqual(SAMPLE_ROWS);
  });
});

describe('transcriptVault — IDB persistence', () => {
  let userId;
  beforeEach(() => {
    userId = nextUserId();
  });

  it('save then load round-trips the blob bytes', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    const db = await openTranscriptStore(userId);
    try {
      await saveTranscriptBlob(db, blob);
      const loaded = await loadTranscriptBlob(db);
      expect(loaded).not.toBeNull();
      expect(Array.from(loaded)).toEqual(Array.from(blob));
    } finally {
      db.close();
    }
  });

  it('load returns null when no blob has been saved yet', async () => {
    const db = await openTranscriptStore(userId);
    try {
      const loaded = await loadTranscriptBlob(db);
      expect(loaded).toBeNull();
    } finally {
      db.close();
    }
  });

  it('deleteTranscriptDatabase removes the per-user IDB', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    const db = await openTranscriptStore(userId);
    await saveTranscriptBlob(db, blob);
    db.close();

    await deleteTranscriptDatabase(userId);

    const db2 = await openTranscriptStore(userId);
    try {
      const loaded = await loadTranscriptBlob(db2);
      expect(loaded).toBeNull();
    } finally {
      db2.close();
    }
  });
});

describe('transcriptVault — in-memory cache', () => {
  beforeEach(() => clearTranscriptCache());

  it('starts empty and reports unloaded', () => {
    const status = getTranscriptCacheStatus();
    expect(status.loaded).toBe(false);
    expect(status.size).toBe(0);
  });

  it('setTranscriptCache populates entries by messageId', () => {
    setTranscriptCache('user-x', SAMPLE_ROWS);
    expect(getTranscriptCacheStatus().loaded).toBe(true);
    expect(getTranscriptCacheStatus().size).toBe(3);
    expect(getTranscriptEntry('m1')).toEqual(SAMPLE_ROWS[0]);
    expect(getTranscriptEntry('does-not-exist')).toBeNull();
  });

  it('clearTranscriptCache empties the cache and resets the loaded flag', () => {
    setTranscriptCache('user-x', SAMPLE_ROWS);
    clearTranscriptCache();
    expect(getTranscriptEntry('m1')).toBeNull();
    expect(getTranscriptCacheStatus().loaded).toBe(false);
  });

  it('setTranscriptCache replaces previous entries (not merges)', () => {
    setTranscriptCache('user-x', SAMPLE_ROWS);
    setTranscriptCache('user-x', [SAMPLE_ROWS[0]]);
    expect(getTranscriptCacheStatus().size).toBe(1);
    expect(getTranscriptEntry('m2')).toBeNull();
  });

  it('listTranscriptCacheEntries returns an empty array when the cache is empty', () => {
    expect(listTranscriptCacheEntries()).toEqual([]);
  });

  it('listTranscriptCacheEntries returns one entry per cached row', () => {
    setTranscriptCache('user-x', SAMPLE_ROWS);
    const rows = listTranscriptCacheEntries();
    expect(rows).toHaveLength(SAMPLE_ROWS.length);
    const ids = rows.map((row) => row.messageId).sort();
    expect(ids).toEqual(['m1', 'm2', 'm3']);
  });

  it('listTranscriptCacheEntries returns copies, not internal mutable references', () => {
    setTranscriptCache('user-x', SAMPLE_ROWS);

    // Mutating the returned array must not change the cache contents.
    const firstSnapshot = listTranscriptCacheEntries();
    firstSnapshot.length = 0;
    firstSnapshot.push({ messageId: 'm9', plaintext: 'forged', timestamp: 9 });
    expect(getTranscriptCacheStatus().size).toBe(SAMPLE_ROWS.length);
    expect(getTranscriptEntry('m1')).toEqual(SAMPLE_ROWS[0]);
    expect(getTranscriptEntry('m9')).toBeNull();

    // Mutating a returned row must not change the cached row.
    const secondSnapshot = listTranscriptCacheEntries();
    const target = secondSnapshot.find((row) => row.messageId === 'm1');
    target.plaintext = 'TAMPERED';
    target.senderId = 'mallory';
    expect(getTranscriptEntry('m1').plaintext).toBe('hello');
    expect(getTranscriptEntry('m1').senderId).toBe('alice');
  });
});

describe('transcriptVault — link export + import flow', () => {
  let userId;
  beforeEach(() => {
    userId = nextUserId();
    clearTranscriptCache();
  });

  it('buildTranscriptBlobForExport produces a blob the same root can decrypt', async () => {
    const blob = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const rows = await decryptTranscriptBlob(key, blob);
    expect(rows).toEqual(SAMPLE_ROWS);
  });

  it('importAndReprotectTranscriptBlob decrypts inbound, re-encrypts under fresh nonce, persists locally', async () => {
    const inbound = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    const rows = await importAndReprotectTranscriptBlob({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      inboundBlob: inbound,
    });
    expect(rows).toEqual(SAMPLE_ROWS);

    // V3 at-rest framed format: legacy 'blob' row no longer holds the
    // re-protected ciphertext; instead the v3-meta + v3-frame:N rows
    // do. Verify both that no legacy row exists and that the framed
    // rows decode back to the same row set.
    const db = await openTranscriptStore(userId);
    let legacyBlob;
    let framed;
    try {
      legacyBlob = await loadTranscriptBlob(db);
      framed = await loadFramedTranscriptAtRest(db);
    } finally {
      db.close();
    }
    expect(legacyBlob).toBeNull();
    expect(framed).not.toBeNull();
    expect(framed.meta.version).toBe(3);
    expect(framed.frames.length).toBeGreaterThan(0);
    // Re-protected: must NOT be byte-identical to anything that crossed
    // the wire (each frame uses a fresh nonce).
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const reRows = await decodeFramedTranscriptAtRest(key, framed.frames);
    expect(reRows).toEqual(SAMPLE_ROWS);
  });

  it('importAndReprotectTranscriptBlob rejects when the root key cannot decrypt the inbound blob', async () => {
    const inbound = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    await expect(importAndReprotectTranscriptBlob({
      userId,
      rootPrivateKey: ROOT_KEY_B,
      inboundBlob: inbound,
    })).rejects.toBeDefined();
  });

  it('loadTranscriptCacheFromDisk returns 0 and seeds an empty cache when no blob is stored', async () => {
    const n = await loadTranscriptCacheFromDisk({
      userId,
      rootPrivateKey: ROOT_KEY_A,
    });
    expect(n).toBe(0);
    expect(getTranscriptCacheStatus().loaded).toBe(true);
    expect(getTranscriptCacheStatus().size).toBe(0);
  });

  it('loadTranscriptCacheFromDisk decrypts the stored blob and seeds the in-memory cache', async () => {
    const inbound = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    await importAndReprotectTranscriptBlob({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      inboundBlob: inbound,
    });

    const n = await loadTranscriptCacheFromDisk({
      userId,
      rootPrivateKey: ROOT_KEY_A,
    });
    expect(n).toBe(SAMPLE_ROWS.length);
    expect(getTranscriptEntry('m2')).toEqual(SAMPLE_ROWS[1]);
  });
});

describe('transcriptVault — generation guard against stale hydrates', () => {
  let userId;
  beforeEach(() => {
    userId = nextUserId();
    clearTranscriptCache();
  });

  it('clearTranscriptCache mid-load prevents stale loadTranscriptCacheFromDisk from re-populating', async () => {
    // Seed the disk so loadTranscriptCacheFromDisk would normally repopulate.
    const inbound = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    await importAndReprotectTranscriptBlob({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      inboundBlob: inbound,
    });
    // The import path itself eagerly seeded the cache. Drop it explicitly to
    // simulate "vault was unlocked, started a hydrate, then locked".
    clearTranscriptCache();
    expect(getTranscriptCacheStatus().loaded).toBe(false);

    // Start a hydrate and, before its inner awaits resolve, simulate a vault
    // lock by clearing the cache. The hydrate must NOT repopulate after.
    const hydratePromise = loadTranscriptCacheFromDisk({
      userId,
      rootPrivateKey: ROOT_KEY_A,
    });
    clearTranscriptCache();

    const n = await hydratePromise;
    expect(n).toBe(0);
    expect(getTranscriptCacheStatus().loaded).toBe(false);
    expect(getTranscriptEntry('m1')).toBeNull();
  });

  it('setTranscriptCache mid-load prevents stale hydrate from overwriting the freshly seeded rows', async () => {
    const inboundFromOldDevice = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    await importAndReprotectTranscriptBlob({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      inboundBlob: inboundFromOldDevice,
    });

    // Pretend a fresh-seeded cache from completeDeviceLink — different rows.
    const freshRows = [
      { messageId: 'mFresh', plaintext: 'fresh row from link', senderId: 'alice', timestamp: 9999 },
    ];
    setTranscriptCache(userId, freshRows);
    expect(getTranscriptEntry('mFresh').plaintext).toBe('fresh row from link');

    // A simultaneously-running hydrate (e.g. from a still-pending unlock fire-
    // and-forget) must NOT clobber the freshly seeded cache.
    const hydratePromise = loadTranscriptCacheFromDisk({
      userId,
      rootPrivateKey: ROOT_KEY_A,
    });
    // No clear in between — the eager seed already bumped the generation,
    // so the hydrate that snapshotted before the seed is now stale.
    setTranscriptCache(userId, freshRows); // re-seed (also bumps gen) to be sure
    const n = await hydratePromise;
    expect(n).toBe(0);
    expect(getTranscriptEntry('mFresh').plaintext).toBe('fresh row from link');
    expect(getTranscriptEntry('m1')).toBeNull();
  });
});

// ── V3 framed transcript wire format + streaming decoder ───────────────
import {
  encryptTranscriptBlobFramed,
  createFramedTranscriptStreamDecoder,
  importAndReprotectTranscriptRows,
  saveFramedTranscriptAtRest,
  loadFramedTranscriptAtRest,
  decodeFramedTranscriptAtRest,
  createStreamingTranscriptImporter,
  beginTranscriptCacheStream,
  appendTranscriptCacheRows,
  finalizeTranscriptCacheStream,
} from './transcriptVault';

describe('transcriptVault — V3 framed wire format', () => {
  it('round-trips rows through encryptTranscriptBlobFramed → createFramedTranscriptStreamDecoder', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push({ messageId: `m${i}`, plaintext: `body-${i}`, timestamp: i });

    const blob = await encryptTranscriptBlobFramed(key, rows, 8); // many small frames
    const decoder = createFramedTranscriptStreamDecoder(key);
    // Feed in many small chunks to exercise the streaming buffer.
    for (let off = 0; off < blob.byteLength; off += 13) {
      await decoder.feed(blob.subarray(off, Math.min(off + 13, blob.byteLength)));
    }
    const decoded = await decoder.finish();
    expect(decoded).toEqual(rows);
  });

  it('decryptTranscriptBlob detects V3 magic and decodes the same blob', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlobFramed(key, SAMPLE_ROWS, 1);
    const decoded = await decryptTranscriptBlob(key, blob);
    expect(decoded).toEqual(SAMPLE_ROWS);
  });

  it('streaming decoder falls back to V2 whole-blob mode when magic is absent', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    // Build a V2 blob via the existing path.
    const v2Blob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    const decoder = createFramedTranscriptStreamDecoder(key);
    await decoder.feed(v2Blob);
    const decoded = await decoder.finish();
    expect(decoded).toEqual(SAMPLE_ROWS);
  });

  it('streaming decoder rejects a tampered frame ciphertext', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlobFramed(key, SAMPLE_ROWS, 1);
    // Flip a byte well past the magic + first length so it lands in the
    // first frame's ciphertext.
    const tampered = new Uint8Array(blob);
    const tamperOffset = 4 /* magic */ + 4 /* len */ + 12 /* nonce */ + 5;
    tampered[tamperOffset] ^= 0xff;
    const decoder = createFramedTranscriptStreamDecoder(key);
    await expect((async () => {
      await decoder.feed(tampered);
      return decoder.finish();
    })()).rejects.toThrow();
  });

  it('streaming decoder rejects a wrong key', async () => {
    const keyA = await deriveTranscriptKey(ROOT_KEY_A);
    const keyB = await deriveTranscriptKey(ROOT_KEY_B);
    const blob = await encryptTranscriptBlobFramed(keyA, SAMPLE_ROWS, 1);
    const decoder = createFramedTranscriptStreamDecoder(keyB);
    await expect((async () => {
      await decoder.feed(blob);
      return decoder.finish();
    })()).rejects.toThrow();
  });

  it('streaming decoder throws if the stream is truncated before the sentinel', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const blob = await encryptTranscriptBlobFramed(key, SAMPLE_ROWS, 1);
    // Drop the trailing sentinel (last 4 bytes).
    const truncated = blob.subarray(0, blob.byteLength - 4);
    const decoder = createFramedTranscriptStreamDecoder(key);
    await decoder.feed(truncated);
    await expect(decoder.finish()).rejects.toThrow(/truncated before sentinel/i);
  });

  it('importAndReprotectTranscriptRows persists rows in the V3 framed at-rest format', async () => {
    const userId = nextUserId();
    const persistedRows = await importAndReprotectTranscriptRows({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      rows: SAMPLE_ROWS,
    });
    expect(persistedRows).toEqual(SAMPLE_ROWS);

    // V3 at-rest: legacy 'blob' row absent, v3-meta + v3-frame:N
    // rows present.
    const db = await openTranscriptStore(userId);
    let legacy;
    let framed;
    try {
      legacy = await loadTranscriptBlob(db);
      framed = await loadFramedTranscriptAtRest(db);
    } finally { db.close(); }
    expect(legacy).toBeNull();
    expect(framed).not.toBeNull();
    expect(framed.meta.version).toBe(3);
    expect(framed.meta.totalRows).toBe(SAMPLE_ROWS.length);
    expect(framed.frames.length).toBe(framed.meta.frameCount);

    // Round-trip via the framed decoder recovers the rows.
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const rows = await decodeFramedTranscriptAtRest(key, framed.frames);
    expect(rows).toEqual(SAMPLE_ROWS);

    deleteTranscriptDatabase(userId);
  });

  it('buildTranscriptBlobForExport now emits the V3 framed format', async () => {
    const blob = await buildTranscriptBlobForExport(ROOT_KEY_A, SAMPLE_ROWS);
    // First 4 bytes are the V3 magic "HT3\0".
    expect(Array.from(blob.subarray(0, 4))).toEqual([0x48, 0x54, 0x33, 0x00]);
    // Round-trip via decryptTranscriptBlob (which now handles V3) recovers rows.
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const rows = await decryptTranscriptBlob(key, blob);
    expect(rows).toEqual(SAMPLE_ROWS);
  });
});

describe('transcriptVault — V3 at-rest framed format', () => {
  it('saveFramedTranscriptAtRest + loadFramedTranscriptAtRest round-trip', async () => {
    const userId = nextUserId();
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const db = await openTranscriptStore(userId);
    try {
      await saveFramedTranscriptAtRest(db, key, SAMPLE_ROWS, 1);
      const framed = await loadFramedTranscriptAtRest(db);
      expect(framed).not.toBeNull();
      expect(framed.meta.frameCount).toBe(SAMPLE_ROWS.length);
      expect(framed.meta.totalRows).toBe(SAMPLE_ROWS.length);
      const rows = await decodeFramedTranscriptAtRest(key, framed.frames);
      expect(rows).toEqual(SAMPLE_ROWS);
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('replacing existing at-rest state clears prior legacy and framed rows in one tx', async () => {
    const userId = nextUserId();
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const db = await openTranscriptStore(userId);
    try {
      // Seed a legacy V2 'blob' row.
      const legacyBlob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
      await saveTranscriptBlob(db, legacyBlob);
      let pre = await loadTranscriptBlob(db);
      expect(pre).not.toBeNull();
      // Now overwrite with V3 framed.
      await saveFramedTranscriptAtRest(db, key, SAMPLE_ROWS, 1);
      // Legacy blob row must be gone; framed rows must be present.
      const legacyAfter = await loadTranscriptBlob(db);
      const framedAfter = await loadFramedTranscriptAtRest(db);
      expect(legacyAfter).toBeNull();
      expect(framedAfter).not.toBeNull();
      expect(framedAfter.meta.frameCount).toBe(SAMPLE_ROWS.length);
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('loadTranscriptCacheFromDisk reads V3 at-rest correctly', async () => {
    const userId = nextUserId();
    await importAndReprotectTranscriptRows({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      rows: SAMPLE_ROWS,
    });
    const n = await loadTranscriptCacheFromDisk({
      userId,
      rootPrivateKey: ROOT_KEY_A,
    });
    expect(n).toBe(SAMPLE_ROWS.length);
    expect(getTranscriptEntry('m1').plaintext).toBe('hello');
    deleteTranscriptDatabase(userId);
  });

  it('loadTranscriptCacheFromDisk falls back to legacy V2 blob when no V3 meta exists', async () => {
    const userId = nextUserId();
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const legacyBlob = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    const db = await openTranscriptStore(userId);
    try { await saveTranscriptBlob(db, legacyBlob); } finally { db.close(); }
    // No V3 meta written. The cache loader must fall back to the V2 blob.
    const n = await loadTranscriptCacheFromDisk({
      userId,
      rootPrivateKey: ROOT_KEY_A,
    });
    expect(n).toBe(SAMPLE_ROWS.length);
    expect(getTranscriptEntry('m1').plaintext).toBe('hello');
    deleteTranscriptDatabase(userId);
  });

  it('decodeFramedTranscriptAtRest rejects a tampered frame', async () => {
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const userId = nextUserId();
    const db = await openTranscriptStore(userId);
    try {
      await saveFramedTranscriptAtRest(db, key, SAMPLE_ROWS, 1);
      const framed = await loadFramedTranscriptAtRest(db);
      // Flip a byte inside the first frame's ciphertext (offset 12 = first
      // byte after the 12-byte nonce).
      framed.frames[0][12] ^= 0xff;
      await expect(decodeFramedTranscriptAtRest(key, framed.frames)).rejects.toThrow();
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('decodeFramedTranscriptAtRest rejects a wrong key', async () => {
    const keyA = await deriveTranscriptKey(ROOT_KEY_A);
    const keyB = await deriveTranscriptKey(ROOT_KEY_B);
    const userId = nextUserId();
    const db = await openTranscriptStore(userId);
    try {
      await saveFramedTranscriptAtRest(db, keyA, SAMPLE_ROWS, 1);
      const framed = await loadFramedTranscriptAtRest(db);
      await expect(decodeFramedTranscriptAtRest(keyB, framed.frames)).rejects.toThrow();
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('importAndReprotectTranscriptBlob lazy-upgrades a V2 inbound blob to V3 at-rest', async () => {
    const userId = nextUserId();
    const inbound = await encryptTranscriptBlob(
      await deriveTranscriptKey(ROOT_KEY_A),
      SAMPLE_ROWS,
    );
    const rows = await importAndReprotectTranscriptBlob({
      userId,
      rootPrivateKey: ROOT_KEY_A,
      inboundBlob: inbound,
    });
    expect(rows).toEqual(SAMPLE_ROWS);
    const db = await openTranscriptStore(userId);
    let legacy;
    let framed;
    try {
      legacy = await loadTranscriptBlob(db);
      framed = await loadFramedTranscriptAtRest(db);
    } finally { db.close(); }
    expect(legacy).toBeNull();
    expect(framed).not.toBeNull();
    expect(framed.meta.totalRows).toBe(SAMPLE_ROWS.length);
    deleteTranscriptDatabase(userId);
  });

  it('handles an empty rows array round-trip', async () => {
    const userId = nextUserId();
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const db = await openTranscriptStore(userId);
    try {
      await saveFramedTranscriptAtRest(db, key, [], 1024);
      const framed = await loadFramedTranscriptAtRest(db);
      expect(framed.meta.frameCount).toBe(0);
      const rows = await decodeFramedTranscriptAtRest(key, framed.frames);
      expect(rows).toEqual([]);
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });
});

describe('transcriptVault — streaming wire-to-at-rest importer', () => {
  beforeEach(() => { clearTranscriptCache(); });

  async function buildWireBlob(rootKey, rows, rowsPerFrame = 4) {
    const key = await deriveTranscriptKey(rootKey);
    return encryptTranscriptBlobFramed(key, rows, rowsPerFrame);
  }

  it('streams wire frames straight into V3 at-rest without a whole-rows array', async () => {
    const userId = nextUserId();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      messageId: `m${i}`, plaintext: `p${i}`, timestamp: i,
    }));
    const wireBlob = await buildWireBlob(ROOT_KEY_A, rows, 4);

    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const db = await openTranscriptStore(userId);
    try {
      const importer = createStreamingTranscriptImporter({ db, key, userId, rowsPerFrame: 4 });
      const decoder = createFramedTranscriptStreamDecoder(key, {
        onFrameRows: (subset) => importer.appendFrame(subset),
      });
      // Feed in tiny chunks to exercise streaming.
      for (let off = 0; off < wireBlob.byteLength; off += 9) {
        await decoder.feed(wireBlob.subarray(off, Math.min(off + 9, wireBlob.byteLength)));
      }
      const finishResult = await decoder.finish();
      // Decoder did NOT accumulate rows internally because onFrameRows
      // dispatched them.
      expect(finishResult).toEqual([]);
      await importer.commit();

      // Every row is now in the cache + readable from at-rest.
      expect(getTranscriptEntry('m0').plaintext).toBe('p0');
      expect(getTranscriptEntry('m11').plaintext).toBe('p11');
      const status = getTranscriptCacheStatus();
      expect(status.loaded).toBe(true);
      expect(status.size).toBe(rows.length);

      const framed = await loadFramedTranscriptAtRest(db);
      expect(framed.meta.frameCount).toBe(Math.ceil(rows.length / 4));
      expect(framed.meta.totalRows).toBe(rows.length);
      const decoded = await decodeFramedTranscriptAtRest(key, framed.frames);
      expect(decoded).toEqual(rows);
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('cache shows loaded=false during streaming and loaded=true after commit', async () => {
    const userId = nextUserId();
    const rows = Array.from({ length: 6 }, (_, i) => ({
      messageId: `m${i}`, plaintext: `p${i}`, timestamp: i,
    }));
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const db = await openTranscriptStore(userId);
    try {
      const importer = createStreamingTranscriptImporter({ db, key, userId, rowsPerFrame: 2 });
      // After init: cache cleared, loaded=false.
      expect(getTranscriptCacheStatus().loaded).toBe(false);
      // Append one frame.
      await importer.appendFrame(rows.slice(0, 2));
      expect(getTranscriptCacheStatus().loaded).toBe(false);   // still mid-stream
      expect(getTranscriptEntry('m0').plaintext).toBe('p0');   // partial visibility OK
      expect(getTranscriptEntry('m5')).toBeNull();             // not yet streamed
      await importer.appendFrame(rows.slice(2, 4));
      await importer.appendFrame(rows.slice(4, 6));
      await importer.commit();
      expect(getTranscriptCacheStatus().loaded).toBe(true);
      expect(getTranscriptEntry('m5').plaintext).toBe('p5');
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('abort discards the new frames without disturbing the prior committed state', async () => {
    const userId = nextUserId();
    const initialRows = [
      { messageId: 'init1', plaintext: 'old1', timestamp: 1 },
      { messageId: 'init2', plaintext: 'old2', timestamp: 2 },
    ];
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    // Seed an initial committed state.
    {
      const db = await openTranscriptStore(userId);
      try {
        await saveFramedTranscriptAtRest(db, key, initialRows, 1);
      } finally { db.close(); }
    }
    // Verify initial state.
    {
      const db = await openTranscriptStore(userId);
      try {
        const f = await loadFramedTranscriptAtRest(db);
        expect(f.meta.totalRows).toBe(2);
      } finally { db.close(); }
    }

    // Start a streaming import, append two frames, then abort.
    const db = await openTranscriptStore(userId);
    try {
      const importer = createStreamingTranscriptImporter({ db, key, userId, rowsPerFrame: 1 });
      await importer.appendFrame([{ messageId: 'mNew1', plaintext: 'new1', timestamp: 10 }]);
      await importer.appendFrame([{ messageId: 'mNew2', plaintext: 'new2', timestamp: 11 }]);
      await importer.abort();
      // The committed state must still be the original initialRows.
      const f = await loadFramedTranscriptAtRest(db);
      expect(f.meta.totalRows).toBe(2);
      const decoded = await decodeFramedTranscriptAtRest(key, f.frames);
      expect(decoded).toEqual(initialRows);
      // Cache: cleared by abort.
      expect(getTranscriptCacheStatus().loaded).toBe(false);
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('a tampered wire frame surfaces an error and does not commit', async () => {
    const userId = nextUserId();
    const rows = [
      { messageId: 'm1', plaintext: 'a', timestamp: 1 },
      { messageId: 'm2', plaintext: 'b', timestamp: 2 },
    ];
    const wireBlob = await buildWireBlob(ROOT_KEY_A, rows, 1);
    // Flip a byte inside the first frame's ciphertext.
    const tampered = new Uint8Array(wireBlob);
    tampered[4 + 4 + 12 + 5] ^= 0xff;
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    const db = await openTranscriptStore(userId);
    try {
      const importer = createStreamingTranscriptImporter({ db, key, userId, rowsPerFrame: 1 });
      const decoder = createFramedTranscriptStreamDecoder(key, {
        onFrameRows: (s) => importer.appendFrame(s),
      });
      let threw = false;
      try {
        await decoder.feed(tampered);
        await decoder.finish();
      } catch {
        threw = true;
        await importer.abort();
      }
      expect(threw).toBe(true);
      // Nothing committed.
      const framed = await loadFramedTranscriptAtRest(db);
      expect(framed).toBeNull();
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });

  it('legacy V1/V2 at-rest blobs still hydrate correctly via loadTranscriptCacheFromDisk', async () => {
    const userId = nextUserId();
    const key = await deriveTranscriptKey(ROOT_KEY_A);
    // Seed legacy V2 'blob' row directly.
    const legacy = await encryptTranscriptBlob(key, SAMPLE_ROWS);
    const db = await openTranscriptStore(userId);
    try { await saveTranscriptBlob(db, legacy); } finally { db.close(); }
    const n = await loadTranscriptCacheFromDisk({ userId, rootPrivateKey: ROOT_KEY_A });
    expect(n).toBe(SAMPLE_ROWS.length);
    expect(getTranscriptEntry('m1').plaintext).toBe('hello');
    deleteTranscriptDatabase(userId);
  });

  it('beginTranscriptCacheStream + appendTranscriptCacheRows + finalizeTranscriptCacheStream round-trips', async () => {
    const userId = nextUserId();
    const gen = beginTranscriptCacheStream(userId);
    expect(getTranscriptCacheStatus().loaded).toBe(false);
    appendTranscriptCacheRows(gen, [{ messageId: 'a', plaintext: 'aa', timestamp: 1 }]);
    appendTranscriptCacheRows(gen, [{ messageId: 'b', plaintext: 'bb', timestamp: 2 }]);
    expect(getTranscriptCacheStatus().loaded).toBe(false);
    expect(getTranscriptEntry('a').plaintext).toBe('aa');
    const ok = finalizeTranscriptCacheStream(gen);
    expect(ok).toBe(true);
    expect(getTranscriptCacheStatus().loaded).toBe(true);
  });

  it('appendTranscriptCacheRows is a no-op when generation has been bumped (vault-lock-style)', async () => {
    const userId = nextUserId();
    const gen = beginTranscriptCacheStream(userId);
    appendTranscriptCacheRows(gen, [{ messageId: 'a', plaintext: 'aa', timestamp: 1 }]);
    // Simulate vault lock / fresh setTranscriptCache mid-stream.
    clearTranscriptCache();
    // The stale generation token must now be ignored.
    appendTranscriptCacheRows(gen, [{ messageId: 'b', plaintext: 'bb', timestamp: 2 }]);
    expect(getTranscriptEntry('b')).toBeNull();
    // finalizeTranscriptCacheStream returns false because generation was bumped.
    expect(finalizeTranscriptCacheStream(gen)).toBe(false);
    expect(getTranscriptCacheStatus().loaded).toBe(false);
  });
});

import { forgetTranscriptEntries } from './transcriptVault';

describe('transcriptVault — forgetting a removed Space (Rituals fork)', () => {
  it('drops forgotten entries now and rewrites them out of the at-rest frames on the next unlock', async () => {
    const userId = nextUserId();
    const rows = [
      { messageId: 'gone-1', plaintext: 'secret', timestamp: 1, channelId: 'ch-gone' },
      { messageId: 'gone-2', plaintext: 'untagged but known', timestamp: 2 },
      { messageId: 'kept', plaintext: 'stays', timestamp: 3, channelId: 'ch-kept' },
    ];
    await importAndReprotectTranscriptRows({ userId, rootPrivateKey: ROOT_KEY_A, rows });
    expect(await loadTranscriptCacheFromDisk({ userId, rootPrivateKey: ROOT_KEY_A })).toBe(3);

    expect(await forgetTranscriptEntries(['gone-2'], ['ch-gone'], userId)).toBe(2);
    expect(getTranscriptEntry('gone-1')).toBeNull();
    expect(getTranscriptEntry('gone-2')).toBeNull();
    expect(getTranscriptEntry('kept').plaintext).toBe('stays');

    // A fresh unlock (e.g. after a reload) must not bring them back, and it
    // rewrites the encrypted frames without them.
    clearTranscriptCache();
    expect(await loadTranscriptCacheFromDisk({ userId, rootPrivateKey: ROOT_KEY_A })).toBe(1);
    expect(getTranscriptEntry('gone-1')).toBeNull();
    expect(getTranscriptEntry('kept').plaintext).toBe('stays');
    const db = await openTranscriptStore(userId);
    try {
      const framed = await loadFramedTranscriptAtRest(db);
      expect(framed.meta.frameCount).toBe(1);
    } finally {
      db.close();
      deleteTranscriptDatabase(userId);
    }
  });
});
