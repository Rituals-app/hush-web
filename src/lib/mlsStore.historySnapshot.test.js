/**
 * Rituals fork (2026-11-05): the device-link history snapshot must never carry
 * the approving device's MLS signing material, and the history store must
 * never bind the active StorageProvider bridge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  openStore,
  openHistoryStore,
  setCredential,
  getCredential,
  exportHistorySnapshot,
  importHistorySnapshot,
  HISTORY_SNAPSHOT_EXCLUDED_STORES,
} from './mlsStore';

let n = 0;
function ids() {
  n += 1;
  return [`snap-user-${n}`, `snap-dev-${n}`];
}

function putRow(db, storeName, row) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function countRows(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function seedActiveStore() {
  const [userId, deviceId] = ids();
  const db = await openStore(userId, deviceId);
  await setCredential(db, {
    signingPublicKey: new Uint8Array([1, 2, 3]),
    signingPrivateKey: new Uint8Array([9, 9, 9]),
    credentialBytes: new Uint8Array([4, 5, 6]),
  });
  await putRow(db, 'mls_signature_key_pairs', { key: 'sig-1', value: [7, 7] });
  await putRow(db, 'mls_own_leaf_nodes', { key: 'leaf-1', value: [8, 8] });
  await putRow(db, 'mls_groups', { key: 'group-1', value: [1] });
  await putRow(db, 'mls_epoch_secrets', { key: 'epoch-1', value: [2] });
  await putRow(db, 'mls_encryption_key_pairs', { key: 'hpke-1', value: [3] });
  await putRow(db, 'mls_epoch_key_pairs', { key: 'epk-1', value: [4] });
  await putRow(db, 'mls_key_packages', { key: 'kp-1', value: [5] });
  await putRow(db, 'mls_message_secrets', { key: 'ms-1', value: [6] });
  await putRow(db, 'groupEpoch', { key: 'chan-1', epoch: 3 });
  return { db, userId, deviceId };
}

describe('history snapshot hygiene', () => {
  beforeEach(() => {
    delete globalThis.window?.mlsStorageBridge;
  });

  it('excludes the credential and every OpenMLS key-material store', () => {
    for (const storeName of [
      'credential',
      'mls_signature_key_pairs',
      'mls_own_leaf_nodes',
      'mls_encryption_key_pairs',
      'mls_epoch_key_pairs',
      'mls_key_packages',
      'mls_encryption_keys',
      'mls_epoch_secrets',
      'mls_message_secrets',
      'mls_group_state',
      'mls_psk',
      'mls_resumption_psk',
    ]) {
      expect(HISTORY_SNAPSHOT_EXCLUDED_STORES).toContain(storeName);
    }
  });

  it('strips all key material from the exported snapshot', async () => {
    const { db } = await seedActiveStore();
    const snapshot = await exportHistorySnapshot(db);

    for (const storeName of HISTORY_SNAPSHOT_EXCLUDED_STORES) {
      expect(Object.prototype.hasOwnProperty.call(snapshot.stores, storeName)).toBe(false);
    }
    expect(JSON.stringify(snapshot)).not.toContain('"signingPrivateKey"');
    expect(Object.keys(snapshot.stores)).toEqual(['groupEpoch']);
    expect(snapshot.stores.groupEpoch).toHaveLength(1);
    db.close();
  });

  it('never imports key-material rows from an older snapshot that still carries them', async () => {
    const [userId, deviceId] = ids();
    const historyDb = await openHistoryStore(userId, deviceId);
    await importHistorySnapshot(historyDb, {
      version: 1,
      stores: {
        credential: [{ key: 'credential', signingPublicKey: [1], signingPrivateKey: [9, 9, 9], credentialBytes: [4] }],
        mls_signature_key_pairs: [{ key: 'sig-legacy', value: [7] }],
        mls_own_leaf_nodes: [{ key: 'leaf-legacy', value: [8] }],
        mls_groups: [{ key: 'group-legacy', value: [1] }],
        mls_encryption_key_pairs: [{ key: 'hpke-legacy', value: [3] }],
        mls_key_packages: [{ key: 'kp-legacy', value: [5] }],
        groupEpoch: [{ key: 'chan-legacy', epoch: 2 }],
      },
    });

    expect(await getCredential(historyDb)).toBeNull();
    expect(await countRows(historyDb, 'mls_signature_key_pairs')).toBe(0);
    expect(await countRows(historyDb, 'mls_own_leaf_nodes')).toBe(0);
    expect(await countRows(historyDb, 'mls_groups')).toBe(0);
    expect(await countRows(historyDb, 'mls_encryption_key_pairs')).toBe(0);
    expect(await countRows(historyDb, 'mls_key_packages')).toBe(0);
    expect(await countRows(historyDb, 'groupEpoch')).toBe(1);
    historyDb.close();
  });

  it('opening the history store does not bind the active bridge', async () => {
    const [userId, deviceId] = ids();
    const historyDb = await openHistoryStore(userId, deviceId);
    expect(globalThis.window?.mlsStorageBridge).toBeUndefined();
    historyDb.close();
  });
});
