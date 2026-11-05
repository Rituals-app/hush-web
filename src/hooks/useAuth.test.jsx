/**
 * useAuth BIP39 auth hook tests.
 *
 * Covers:
 *   - performLogout wipes all storage
 *   - unlockVault correct/incorrect PIN
 *   - PIN attempt counter increments and progressive delays
 *   - performRegister and performChallengeResponse happy path
 *   - Session rehydration: vault 'locked' when session flag absent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { JWT_KEY, getTokenForInstanceUrl } from './useAuth';
import {
  readWrappedIdentity,
  isMarkerAlive,
  clearSessionKey,
  sealIdentityIntoSession,
  markAlive as markVaultSessionAlive,
} from '../lib/vaultSessionKey';
import { queryClient } from '../lib/queryClient';

// ── authInstanceStore mock (must be declared before module imports) ─────────────
let _mockActiveInstanceUrl = '';
const _mockMarkAuthInstanceUsed = vi.hoisted(() => vi.fn(async (value) => value));
vi.mock('../lib/authInstanceStore', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getActiveAuthInstanceUrlSync: () => _mockActiveInstanceUrl,
    markAuthInstanceUsed: _mockMarkAuthInstanceUsed,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../lib/api', () => ({
  fetchWithAuth: vi.fn(),
  uploadKeyPackagesAfterAuth: vi.fn().mockResolvedValue(undefined),
  requestChallenge: vi.fn(),
  verifyChallenge: vi.fn(),
  registerWithPublicKey: vi.fn(),
  requestGuestSession: vi.fn(),
  listDeviceKeys: vi.fn().mockResolvedValue([]),
  revokeDeviceKey: vi.fn().mockResolvedValue(undefined),
  // Real implementation: normalize the explicit base URL to a canonical
  // origin so the audience-bind assertions can pin exact strings.
  resolveAuthAudience: vi.fn((baseUrl) => {
    if (!baseUrl) return 'https://default.example';
    try {
      const u = new URL(baseUrl);
      return `${u.protocol}//${u.host}`.replace(/\/$/, '');
    } catch {
      return '';
    }
  }),
}));

vi.mock('../lib/transcriptVault', () => ({
  importAndReprotectTranscriptBlob: vi.fn().mockResolvedValue([]),
  loadTranscriptCacheFromDisk: vi.fn().mockResolvedValue(0),
  clearTranscriptCache: vi.fn(),
  deleteTranscriptDatabase: vi.fn().mockResolvedValue(undefined),
  setTranscriptCache: vi.fn(),
}));

vi.mock('../lib/bip39Identity', () => ({
  mnemonicToIdentityKey: vi.fn().mockResolvedValue({
    privateKey: new Uint8Array(32).fill(1),
    publicKey: new Uint8Array(32).fill(2),
  }),
  signAuthChallengeV2: vi.fn().mockResolvedValue(new Uint8Array(64).fill(3)),
  signTransparencyEntry: vi.fn().mockResolvedValue({
    signature: new Uint8Array(64).fill(4),
  }),
}));

// Shared blob store (reset between tests via beforeEach).
const _vaultBlobs = new Map();
const _pinAttempts = new Map();

vi.mock('../lib/identityVault', () => ({
  encryptVault: vi.fn().mockImplementation(async (privateKey) => {
    const blob = new Uint8Array(privateKey.length + 12);
    blob.set(privateKey, 12);
    return blob;
  }),
  decryptVault: vi.fn().mockImplementation(async (blob, pin) => {
    if (pin === 'wrong') throw new DOMException('decryption failed', 'OperationError');
    return new Uint8Array(blob.slice(12));
  }),
  decryptVaultAndExportKey: vi.fn().mockImplementation(async (blob, pin) => {
    if (pin === 'wrong') throw new DOMException('decryption failed', 'OperationError');
    return { privateKey: new Uint8Array(blob.slice(12)), rawKeyHex: 'aabbccdd' };
  }),
  decryptVaultWithRawKey: vi.fn().mockImplementation(async (blob, rawKeyHex) => {
    if (rawKeyHex === 'bad-key') throw new DOMException('decryption failed', 'OperationError');
    return new Uint8Array(blob.slice(12));
  }),
  openVaultStore: vi.fn().mockImplementation(async (userId) => ({
    userId,
    close: vi.fn(),
  })),
  saveEncryptedKey: vi.fn().mockImplementation(async (db, blob) => {
    _vaultBlobs.set(db.userId, blob);
  }),
  loadEncryptedKey: vi.fn().mockImplementation(async (db) => {
    return _vaultBlobs.get(db.userId) ?? null;
  }),
  deleteVaultDatabase: vi.fn().mockResolvedValue(undefined),
  getVaultConfig: vi.fn().mockReturnValue(null),
  setVaultConfig: vi.fn(),
  bytesToHex: vi.fn().mockImplementation((bytes) =>
    Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(''),
  ),
  hexToBytes: vi.fn().mockImplementation((hex) => {
    const result = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      result[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return result;
  }),
  saveSaltToIDB: vi.fn().mockResolvedValue(undefined),
  saveVaultMarkerToIDB: vi.fn().mockResolvedValue(undefined),
  checkVaultExistsInIDB: vi.fn().mockResolvedValue({ exists: false, publicKeyHex: null }),
  loadVaultMarkerFromIDB: vi.fn().mockResolvedValue(null),
  loadPinAttemptsFromIDB: vi.fn().mockImplementation(async (db) =>
    _pinAttempts.get(db.userId) ?? { count: 0, lastAttemptAt: null },
  ),
  savePinAttemptsToIDB: vi.fn().mockImplementation(async (db, record) => {
    _pinAttempts.set(db.userId, record);
  }),
  clearPinAttemptsFromIDB: vi.fn().mockImplementation(async (db) => {
    _pinAttempts.delete(db.userId);
  }),
  isLegacyVaultBlob: vi.fn().mockReturnValue(false),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import * as apiMod from '../lib/api';
import * as vaultMod from '../lib/identityVault';
import * as mlsStoreMod from '../lib/mlsStore';
import * as transcriptVaultMod from '../lib/transcriptVault';
import {
  setInstanceToken,
  getInstanceToken,
  getLocalToken,
  clearSession,
  HOME_INSTANCE_KEY,
} from './useAuth';

// ── Helpers ───────────────────────────────────────────────────────────────────

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;
const SERVER_QUERY_KEY = ['servers', 'https://i.example.com', 'user-1', 'srv-1', 'members'];
const AUTH_QUERY_KEY = ['auth', 'devices', 'https://i.example.com'];

function mockFetchOk(body) {
  return { ok: true, json: () => Promise.resolve(body) };
}

/**
 * Builds a fake (unsigned) JWT with the given payload.
 * The client only reads the payload; it does not verify the signature.
 */
function buildFakeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function seedAuthOwnedQueryData() {
  queryClient.setQueryData(SERVER_QUERY_KEY, [{ id: 'member-1' }]);
  queryClient.setQueryData(AUTH_QUERY_KEY, [{ id: 'device-1' }]);
}

function expectAuthOwnedQueryDataCleared() {
  expect(queryClient.getQueryData(SERVER_QUERY_KEY)).toBeUndefined();
  expect(queryClient.getQueryData(AUTH_QUERY_KEY)).toBeUndefined();
}

function clearVaultUnlockBoundaryMocks() {
  vi.mocked(apiMod.requestChallenge).mockClear();
  vi.mocked(apiMod.verifyChallenge).mockClear();
  vi.mocked(vaultMod.openVaultStore).mockClear();
  vi.mocked(vaultMod.loadEncryptedKey).mockClear();
}

function expectVaultUnlockBoundaryUntouched() {
  expect(vaultMod.openVaultStore).not.toHaveBeenCalled();
  expect(vaultMod.loadEncryptedKey).not.toHaveBeenCalled();
  expect(apiMod.requestChallenge).not.toHaveBeenCalled();
  expect(apiMod.verifyChallenge).not.toHaveBeenCalled();
}

function expectLocalAuthResetState(authState) {
  expect(authState.token).toBeNull();
  expect(authState.user).toBeNull();
  expect(authState.isAuthenticated).toBe(false);
  expect(authState.vaultState).toBe('none');
  expect(authState.hasVault).toBe(false);
  expect(authState.needsPinSetup).toBe(false);
  expect(authState.isGuest).toBe(false);
  expect(authState.guestExpiresAt).toBeNull();
  expect(authState.error).toBeNull();
  expect(authState.loading).toBe(false);
}

class MockBroadcastChannel {
  static instances = [];

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.isClosed = false;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data) {
    for (const instance of MockBroadcastChannel.instances) {
      if (instance === this || instance.isClosed || instance.name !== this.name) continue;
      instance.onmessage?.({ data });
    }
  }

  close() {
    this.isClosed = true;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  queryClient.clear();
  _vaultBlobs.clear();
  _pinAttempts.clear();
  _mockActiveInstanceUrl = '';
  _mockMarkAuthInstanceUsed.mockClear();
  _mockMarkAuthInstanceUsed.mockImplementation(async (value) => {
    _mockActiveInstanceUrl = value;
    return value;
  });

  vi.mocked(apiMod.fetchWithAuth).mockReset();
  vi.mocked(apiMod.fetchWithAuth).mockResolvedValue({ ok: false, status: 401 });
  vi.mocked(apiMod.uploadKeyPackagesAfterAuth).mockResolvedValue(undefined);
  vi.mocked(apiMod.requestChallenge).mockResolvedValue({ nonce: 'deadbeef' });
  vi.mocked(apiMod.verifyChallenge).mockResolvedValue({
    token: 'jwt-test',
    user: { id: 'user-1', username: 'alice', displayName: 'Alice' },
  });
  vi.mocked(apiMod.registerWithPublicKey).mockResolvedValue({
    token: 'jwt-register',
    user: { id: 'user-reg', username: 'newuser', displayName: 'New User' },
  });
  vi.mocked(apiMod.requestGuestSession).mockResolvedValue({
    token: 'jwt-guest',
    guestId: 'guest_abc123',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  vi.mocked(vaultMod.deleteVaultDatabase).mockClear();
  vi.mocked(vaultMod.saveEncryptedKey).mockClear();
  vi.mocked(vaultMod.encryptVault).mockClear();
  vi.mocked(vaultMod.openVaultStore).mockClear();
  vi.mocked(vaultMod.loadPinAttemptsFromIDB).mockClear();
  vi.mocked(vaultMod.savePinAttemptsToIDB).mockClear();
  vi.mocked(vaultMod.clearPinAttemptsFromIDB).mockClear();
  vi.mocked(vaultMod.isLegacyVaultBlob).mockReturnValue(false);
  vi.mocked(vaultMod.getVaultConfig).mockReturnValue(null);
  vi.mocked(vaultMod.setVaultConfig).mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  delete window.hushDesktop;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useAuth - performChallengeResponse', () => {
  it('sets token and user on successful challenge-response', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });

    expect(result.current.token).toBe('jwt-test');
    expect(result.current.user?.id).toBe('user-1');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasSession).toBe(true);
    expect(result.current.hasVault).toBe(true);
    expect(result.current.isVaultUnlocked).toBe(true);
    expect(result.current.needsUnlock).toBe(false);
    expect(result.current.isKnownBrowserProfile).toBe(true);
    expect(result.current.vaultState).toBe('unlocked');
    expect(sessionStorage.getItem(JWT_KEY)).toBe('jwt-test');
  });

  it('uses the provided auth instance for challenge verification and key upload', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        'https://chat.example.com',
      );
    });

    expect(apiMod.requestChallenge).toHaveBeenCalledWith(expect.any(String), 'https://chat.example.com');
    expect(apiMod.verifyChallenge).toHaveBeenCalledWith(
      expect.any(String),
      'deadbeef',
      expect.any(String),
      expect.any(String),
      'https://chat.example.com',
      'https://chat.example.com',
    );
    expect(apiMod.uploadKeyPackagesAfterAuth).toHaveBeenCalledWith(
      'jwt-test',
      'user-1',
      expect.any(String),
      {},
      'https://chat.example.com',
    );
  });

  it('signs the v2 audience-bound payload for performChallengeResponse, never the raw nonce', async () => {
    // Regression for the cross-instance signing-oracle bug fixed in
    // PR #39: performChallengeResponse must call signAuthChallengeV2
    // with (nonceHex, audienceOrigin, privateKey) so the signature is
    // useless when redeemed at any origin other than the one the user
    // intended to authenticate to.
    const bipMod = await import('../lib/bip39Identity');
    vi.mocked(bipMod.signAuthChallengeV2).mockClear();

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const privateKey = new Uint8Array(32).fill(1);
    await act(async () => {
      await result.current.performChallengeResponse(
        privateKey,
        new Uint8Array(32).fill(2),
        'https://chat.example.com',
      );
    });

    expect(bipMod.signAuthChallengeV2).toHaveBeenCalledTimes(1);
    expect(bipMod.signAuthChallengeV2).toHaveBeenCalledWith(
      'deadbeef',
      'https://chat.example.com',
      privateKey,
    );
  });

  it('persists public key hex in localStorage for vault detection', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });

    await waitFor(() => expect(result.current.user?.id).toBe('user-1'));

    const storedHex = localStorage.getItem('hush_vault_user_user-1');
    expect(storedHex).toBeTruthy();
    expect(typeof storedHex).toBe('string');
    expect(storedHex.length).toBe(64);
  });

  it('writes the wrapped identity into the vault session key store on unlock (P21 step 2)', async () => {
    // The unlock path must seed the vault session key store so step 3
    // can resume `vaultState='unlocked'` across reloads. We do not
    // assert the pre-state of the marker / IDB record because the
    // unlock path is fire-and-forget — a previous test in this file
    // can land its write *after* `beforeEach` runs, polluting the
    // baseline. Asserting only the post-unlock state keeps the
    // contract testable without requiring serialization of the prior
    // unlock writes.
    await clearSessionKey('user-1');

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });

    await waitFor(() => expect(result.current.user?.id).toBe('user-1'));
    // The write is fire-and-forget so the unlock UX never blocks on
    // IDB; the marker + IDB record settle in a follow-up microtask.
    await waitFor(() => expect(isMarkerAlive('user-1')).toBe(true));
    await waitFor(async () => {
      const wrapped = await readWrappedIdentity('user-1');
      expect(wrapped).not.toBeNull();
      expect(wrapped.iv.byteLength).toBe(12);
      expect(wrapped.ciphertext.byteLength).toBeGreaterThan(0);
    });
  });

  it('hydrates the transcript cache BEFORE exposing vaultState=unlocked', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let observedStateAtLoad = null;
    vi.mocked(transcriptVaultMod.loadTranscriptCacheFromDisk).mockImplementationOnce(async () => {
      observedStateAtLoad = result.current.vaultState;
      return 0;
    });

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });

    // The hydrate callback fires while vaultState is still NOT 'unlocked' —
    // i.e. before the route gating in Room.jsx flips and Chat.jsx mounts.
    expect(observedStateAtLoad).not.toBe('unlocked');
    // After the call returns, the vault is unlocked as usual.
    expect(result.current.vaultState).toBe('unlocked');
  });
});

describe('useAuth - performRegister', () => {
  it('registers, authenticates, and sets vaultState=unlocked', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister('newuser', 'New User', 'word '.repeat(12).trim());
    });

    expect(result.current.token).toBe('jwt-register');
    expect(result.current.user?.id).toBe('user-reg');
    expect(result.current.vaultState).toBe('unlocked');
    expect(result.current.needsPinSetup).toBe(true);
    expect(sessionStorage.getItem(JWT_KEY)).toBe('jwt-register');
    expect(apiMod.registerWithPublicKey).toHaveBeenCalledOnce();
  });

  it('registers and uploads MLS state against the provided auth instance', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister(
        'newuser',
        'New User',
        'word '.repeat(12).trim(),
        undefined,
        'https://chat.example.com',
      );
    });

    expect(apiMod.registerWithPublicKey).toHaveBeenCalledWith(
      'newuser',
      'New User',
      expect.any(String),
      expect.any(String),
      undefined,
      'https://chat.example.com',
      expect.any(String),
      expect.any(Number),
    );
    expect(apiMod.uploadKeyPackagesAfterAuth).toHaveBeenCalledWith(
      'jwt-register',
      'user-reg',
      expect.any(String),
      {},
      'https://chat.example.com',
    );
  });

  it('resets state on registration failure', async () => {
    vi.mocked(apiMod.registerWithPublicKey).mockRejectedValueOnce(new Error('username taken'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      try {
        await result.current.performRegister('existing', 'User', 'some mnemonic');
      } catch { /* expected */ }
    });

    expect(result.current.vaultState).toBe('none');
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(result.current.needsPinSetup).toBe(false);
  });

  it('stores home instance URL in localStorage on registration', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister(
        'newuser',
        'New User',
        'word '.repeat(12).trim(),
        undefined,
        'https://chat.example.com',
      );
    });

    expect(localStorage.getItem(HOME_INSTANCE_KEY)).toBe('https://chat.example.com');
  });

  it('stores window.location.origin when no baseUrl is provided on registration', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister('newuser', 'New User', 'word '.repeat(12).trim());
    });

    // jsdom sets window.location.origin to 'http://localhost' by default.
    expect(localStorage.getItem(HOME_INSTANCE_KEY)).toBe(window.location.origin);
  });
});

describe('useAuth - completeDeviceLink', () => {
  it('imports the history snapshot, publishes the auth session, and requires PIN setup', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const historyDb = { close: vi.fn() };
    const openHistoryStoreSpy = vi.spyOn(mlsStoreMod, 'openHistoryStore').mockResolvedValue(historyDb);
    const importHistorySnapshotSpy = vi.spyOn(mlsStoreMod, 'importHistorySnapshot').mockResolvedValue(undefined);

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: { stores: { localPlaintext: [] } },
      instanceUrl: 'https://chat.example.com',
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
    });

    expect(openHistoryStoreSpy).toHaveBeenCalledWith('user-1', expect.any(String));
    expect(importHistorySnapshotSpy).toHaveBeenCalledWith(historyDb, bundle.historySnapshot);
    expect(historyDb.close).toHaveBeenCalledTimes(1);
    expect(result.current.token).toBe('jwt-test');
    expect(result.current.user?.id).toBe('user-1');
    expect(result.current.needsPinSetup).toBe(true);
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('jwt-test');
    expect(_mockMarkAuthInstanceUsed).toHaveBeenCalledWith('https://chat.example.com');

    openHistoryStoreSpy.mockRestore();
    importHistorySnapshotSpy.mockRestore();
  });

  it('does not let stale no-token startup reset a just-completed device link', async () => {
    let resolveVaultCheck;
    vi.mocked(vaultMod.checkVaultExistsInIDB).mockImplementationOnce(() => new Promise((resolve) => {
      resolveVaultCheck = resolve;
    }));
    localStorage.setItem('hush_vault_user__last_user', 'stale-user');

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(vaultMod.checkVaultExistsInIDB).toHaveBeenCalledWith('stale-user');
    });

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      instanceUrl: 'https://chat.example.com',
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
    });

    await waitFor(() => {
      expect(result.current.token).toBe('jwt-test');
      expect(result.current.user?.id).toBe('user-1');
      expect(result.current.vaultState).toBe('unlocked');
    });

    await act(async () => {
      resolveVaultCheck({ exists: false, publicKeyHex: null });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.token).toBe('jwt-test');
    expect(result.current.user?.id).toBe('user-1');
    expect(result.current.vaultState).toBe('unlocked');
  });

  it('decrypts, re-protects, AND eagerly seeds the transcript cache before publishing the session', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const historyDb = { close: vi.fn() };
    const openHistoryStoreSpy = vi.spyOn(mlsStoreMod, 'openHistoryStore').mockResolvedValue(historyDb);
    const importHistorySnapshotSpy = vi.spyOn(mlsStoreMod, 'importHistorySnapshot').mockResolvedValue(undefined);

    const importedRows = [
      { messageId: 'm1', plaintext: 'inherited hi', senderId: 'alice', timestamp: 1 },
    ];
    vi.mocked(transcriptVaultMod.importAndReprotectTranscriptBlob).mockClear();
    vi.mocked(transcriptVaultMod.setTranscriptCache).mockClear();
    vi.mocked(transcriptVaultMod.importAndReprotectTranscriptBlob).mockResolvedValue(importedRows);

    // Track session publication via sessionStorage.setItem so we can assert
    // that the cache was seeded BEFORE the session was published.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const transcriptBlob = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 99]);
    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: { stores: {} },
      transcriptBlob,
      instanceUrl: 'https://chat.example.com',
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
    });

    expect(transcriptVaultMod.importAndReprotectTranscriptBlob).toHaveBeenCalledWith({
      userId: 'user-1',
      rootPrivateKey: bundle.rootPrivateKey,
      inboundBlob: transcriptBlob,
    });
    expect(transcriptVaultMod.setTranscriptCache).toHaveBeenCalledWith('user-1', importedRows);

    // Assert ordering: setTranscriptCache invoked BEFORE the JWT was written to
    // sessionStorage (which is the observable side-effect of session publish).
    const seedOrder = vi.mocked(transcriptVaultMod.setTranscriptCache).mock.invocationCallOrder[0];
    const jwtSetItemCall = setItemSpy.mock.calls.findIndex((call) => (
      typeof call[0] === 'string' && call[0].startsWith('hush_jwt') && call[1] === 'jwt-test'
    ));
    expect(jwtSetItemCall).toBeGreaterThanOrEqual(0);
    const jwtSetOrder = setItemSpy.mock.invocationCallOrder[jwtSetItemCall];
    expect(seedOrder).toBeLessThan(jwtSetOrder);

    expect(result.current.token).toBe('jwt-test');
    expect(result.current.user?.id).toBe('user-1');

    setItemSpy.mockRestore();
    openHistoryStoreSpy.mockRestore();
    importHistorySnapshotSpy.mockRestore();
  });

  it('still completes link when transcript import throws', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const historyDb = { close: vi.fn() };
    const openHistoryStoreSpy = vi.spyOn(mlsStoreMod, 'openHistoryStore').mockResolvedValue(historyDb);
    const importHistorySnapshotSpy = vi.spyOn(mlsStoreMod, 'importHistorySnapshot').mockResolvedValue(undefined);

    vi.mocked(transcriptVaultMod.importAndReprotectTranscriptBlob)
      .mockRejectedValueOnce(new Error('decrypt failed'));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: { stores: {} },
      transcriptBlob: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 99]),
      instanceUrl: 'https://chat.example.com',
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
    });

    expect(result.current.token).toBe('jwt-test');
    expect(result.current.user?.id).toBe('user-1');
    expect(result.current.needsPinSetup).toBe(true);

    openHistoryStoreSpy.mockRestore();
    importHistorySnapshotSpy.mockRestore();
  });

  it('rejects when caller-provided baseUrl and bundle.instanceUrl differ after normalization', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      // Untrusted bundle field points at a different instance than
      // the device originally selected/polled.
      instanceUrl: 'https://attacker.example.com',
    };

    await act(async () => {
      try {
        await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
      } catch {
        // The mismatch guard rethrows after recording state; the rethrow
        // is the caller-visible signal of fail-closed.
      }
    });

    // Fail-closed: no JWT stored for either origin, no auth-instance
    // marked, no markAuthInstanceUsed against the attacker URL.
    expect(result.current.token).toBeNull();
    expect(String(result.current.error?.message ?? result.current.error)).toMatch(
      /instance mismatch/i,
    );
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBeNull();
    expect(sessionStorage.getItem('hush_jwt_attacker.example.com')).toBeNull();
    expect(_mockMarkAuthInstanceUsed).not.toHaveBeenCalledWith('https://attacker.example.com');
  });

  it('accepts equivalent normalized origins for selected and bundle URLs', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      // Bundle carries a trailing-slash form of the same origin.
      instanceUrl: 'https://chat.example.com/',
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
    });

    expect(result.current.token).toBe('jwt-test');
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('jwt-test');
    expect(_mockMarkAuthInstanceUsed).toHaveBeenCalledWith('https://chat.example.com');
  });

  it('still works for legacy callers that pass only bundle.instanceUrl', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      instanceUrl: 'https://chat.example.com',
    };

    await act(async () => {
      // Legacy call without expected baseUrl — bundle.instanceUrl
      // is the only source available, so it is used.
      await result.current.completeDeviceLink(bundle);
    });

    expect(result.current.token).toBe('jwt-test');
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('jwt-test');
    expect(_mockMarkAuthInstanceUsed).toHaveBeenCalledWith('https://chat.example.com');
  });

  it('accepts a selected baseUrl when the bundle omits instanceUrl', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      // No instanceUrl on the bundle — caller-provided baseUrl wins.
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://chat.example.com');
    });

    expect(result.current.token).toBe('jwt-test');
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('jwt-test');
    expect(_mockMarkAuthInstanceUsed).toHaveBeenCalledWith('https://chat.example.com');
  });

  // Rituals fork: one Space identity per Rituals account.
  it('treats the two Rituals Space origins as one instance', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      instanceUrl: 'https://space.rituals.app',
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://space.rit.al');
    });

    expect(result.current.token).toBe('jwt-test');
    // Auth stays on this device's own origin.
    expect(sessionStorage.getItem('hush_jwt_space.rit.al')).toBe('jwt-test');
    expect(_mockMarkAuthInstanceUsed).toHaveBeenCalledWith('https://space.rit.al');
  });

  it('refuses a bundle from a different Rituals account', async () => {
    localStorage.setItem('rituals_space_account', 'b'.repeat(64));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      instanceUrl: 'https://space.rit.al',
      acct: 'a'.repeat(64),
    };

    await act(async () => {
      try {
        await result.current.completeDeviceLink(bundle, 'https://space.rit.al');
      } catch {
        // fail-closed rethrow
      }
    });

    expect(result.current.token).toBeNull();
    expect(String(result.current.error?.message ?? result.current.error)).toMatch(/another Rituals account/i);
    expect(sessionStorage.getItem('hush_jwt_space.rit.al')).toBeNull();
    expect(localStorage.getItem('rituals_space_account')).toBe('b'.repeat(64));
  });

  it('stores the account marker and keeps the no-PIN policy for a Space link', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const bundle = {
      rootPrivateKey: new Uint8Array(32).fill(1),
      rootPublicKey: new Uint8Array(32).fill(2),
      historySnapshot: null,
      instanceUrl: 'https://space.rit.al',
      acct: 'a'.repeat(64),
    };

    await act(async () => {
      await result.current.completeDeviceLink(bundle, 'https://space.rit.al');
    });

    expect(result.current.token).toBe('jwt-test');
    expect(localStorage.getItem('rituals_space_account')).toBe('a'.repeat(64));
    expect(localStorage.getItem('rituals_space_just_linked')).toBe('1');
    expect(result.current.needsPinSetup).toBe(false);
  });
});

describe('useAuth - unlockVault', () => {
  async function setupLockedVault(result) {
    // Complete auth to create user state.
    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));

    // Save encrypted key.
    await act(async () => {
      await result.current.setPIN('correct');
    });

    // Lock the vault.
    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));
  }

  it('unlockVault with correct PIN sets vaultState=unlocked', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(result.current.vaultState).toBe('unlocked');
  });

  it('blocks PIN unlock and destroys local state when a revoked-device tombstone exists', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    expect(localStorage.getItem('hush_vault_user_user-1')).not.toBeNull();
    localStorage.setItem(
      'hush_auth_invalidation',
      JSON.stringify({ reason: 'device_revoked', at: '2026-05-19T00:00:00Z' }),
    );
    clearVaultUnlockBoundaryMocks();

    await expect(result.current.unlockVault('correct')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });

    expectVaultUnlockBoundaryUntouched();
    await waitFor(() => expect(result.current.vaultState).toBe('none'));
    expect(localStorage.getItem('hush_vault_user_user-1')).toBeNull();
    expect(result.current.hasVault).toBe(false);
    expect(vaultMod.deleteVaultDatabase).toHaveBeenCalledWith('user-1');
    expect(transcriptVaultMod.deleteTranscriptDatabase).toHaveBeenCalledWith('user-1');
  });

  it('blocks PIN unlock when only in-memory state reports device revocation', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
        detail: { reason: 'device_revoked' },
      }));
    });
    localStorage.removeItem('hush_auth_invalidation');
    expect(result.current.authInvalidation?.reason).toBe('device_revoked');
    clearVaultUnlockBoundaryMocks();

    await expect(result.current.unlockVault('correct')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });

    expectVaultUnlockBoundaryUntouched();
  });

  it('migrates a legacy vault blob after a successful PIN unlock', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    vi.mocked(vaultMod.isLegacyVaultBlob).mockReturnValueOnce(true);
    vi.mocked(vaultMod.encryptVault).mockClear();
    vi.mocked(vaultMod.saveEncryptedKey).mockClear();

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(vaultMod.encryptVault).toHaveBeenCalledWith(
      new Uint8Array(32).fill(1),
      'correct',
    );
    expect(vaultMod.saveEncryptedKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.any(Uint8Array),
    );
  });

  it('unlockVault with wrong PIN increments attempt counter', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    vi.mocked(vaultMod.savePinAttemptsToIDB).mockClear();

    await act(async () => {
      try { await result.current.unlockVault('wrong'); } catch { /* expected */ }
    });

    expect(vaultMod.savePinAttemptsToIDB).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ count: 1 }),
    );
    expect(localStorage.getItem('hush_pin_attempts_user-1')).toBeNull();
  });

  it('unlockVault clears attempt counter on success after failures', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);

    // One failure.
    await act(async () => {
      try { await result.current.unlockVault('wrong'); } catch { /* expected */ }
    });

    // Correct PIN.
    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(vaultMod.clearPinAttemptsFromIDB).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(localStorage.getItem('hush_pin_attempts_user-1')).toBeNull();
  });

  it('unlockVault with wrong PIN throws WRONG_PIN error code', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);

    let caught;
    await act(async () => {
      try { await result.current.unlockVault('wrong'); } catch (err) { caught = err; }
    });

    expect(caught?.code).toBe('WRONG_PIN');
    expect(result.current.vaultState).toBe('locked');
  });

  it('does not count server invalidation after a correct PIN as a PIN failure', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    const notFound = Object.assign(new Error('unknown public key'), { status: 404 });
    vi.mocked(apiMod.verifyChallenge).mockRejectedValueOnce(notFound);

    let caught;
    await act(async () => {
      try { await result.current.unlockVault('correct'); } catch (err) { caught = err; }
    });

    expect(caught?.code).toBe('SERVER_SESSION_INVALIDATED');
    expect(localStorage.getItem('hush_pin_attempts_user-1')).toBeNull();
    expect(vaultMod.deleteVaultDatabase).not.toHaveBeenCalled();
    expect(result.current.authInvalidation?.reason).toBe('server_session_invalid');
    expect(result.current.needsUnlock).toBe(false);
    expect(result.current.hasVault).toBe(true);
  });

  it('falls back to offline unlock when the server is unreachable (no JWT)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    const networkError = new Error('request challenge failed. Could not reach https://app.gethush.live/api/auth/challenge.');
    vi.mocked(apiMod.requestChallenge).mockRejectedValueOnce(networkError);

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(result.current.vaultState).toBe('unlocked');
    expect(localStorage.getItem('hush_pin_attempts_user-1')).toBeNull();
    expect(result.current.authInvalidation).toBeNull();
    // Offline unlock must be a full session: user rebuilt from the local
    // snapshot so the boot controller routes into the app, not to login.
    expect(result.current.user?.id).toBe('user-1');
    expect(result.current.user?.username).toBe('alice');
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('falls back to offline unlock when a 2xx response is not JSON (captive portal)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    const portalError = Object.assign(
      new Error('requestChallenge returned text/html instead of JSON'),
      { status: 200 },
    );
    vi.mocked(apiMod.requestChallenge).mockRejectedValueOnce(portalError);

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(result.current.vaultState).toBe('unlocked');
  });

  it('reports lifecycle=authorized after an offline unlock', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    vi.mocked(apiMod.requestChallenge).mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(result.current.lifecycle).toBe('authorized');
    expect(result.current.needsUnlock).toBe(false);
  });

  it('does not resurrect the session via the online event after lockVault', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    vi.mocked(apiMod.requestChallenge).mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      await result.current.unlockVault('correct');
    });
    expect(result.current.vaultState).toBe('unlocked');

    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));
    vi.mocked(apiMod.verifyChallenge).mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(apiMod.verifyChallenge).not.toHaveBeenCalled();
    expect(result.current.token).toBeNull();
    expect(result.current.vaultState).toBe('locked');
  });

  it('mints a fresh JWT via the online event after an offline unlock', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    const networkError = new Error('request challenge failed. Could not reach the server.');
    vi.mocked(apiMod.requestChallenge).mockRejectedValueOnce(networkError);

    await act(async () => {
      await result.current.unlockVault('correct');
    });
    expect(result.current.vaultState).toBe('unlocked');
    expect(result.current.token).toBeNull();

    // Server comes back: requestChallenge resolves again (default mock).
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(result.current.token).toBe('jwt-test'));
  });

  it('falls back to offline unlock when the server returns a 5xx/CDN error (no JWT)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    const cdnError = Object.assign(new Error('requestChallenge 526'), { status: 526 });
    vi.mocked(apiMod.requestChallenge).mockRejectedValueOnce(cdnError);

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(result.current.vaultState).toBe('unlocked');
  });

  it('still surfaces explicit auth rejections instead of unlocking offline (no JWT)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);
    clearSession();
    const rejection = Object.assign(new Error('bad signature'), { status: 401 });
    vi.mocked(apiMod.verifyChallenge).mockRejectedValueOnce(rejection);

    let caught;
    await act(async () => {
      try { await result.current.unlockVault('correct'); } catch (err) { caught = err; }
    });

    expect(caught?.status).toBe(401);
    expect(result.current.vaultState).not.toBe('unlocked');
  });

  it('hydrates the transcript cache BEFORE flipping vaultState back to unlocked', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await setupLockedVault(result);

    let observedStateAtLoad = null;
    let observedTranscriptCallCount = 0;
    vi.mocked(transcriptVaultMod.loadTranscriptCacheFromDisk).mockImplementationOnce(async () => {
      observedTranscriptCallCount = vi.mocked(transcriptVaultMod.loadTranscriptCacheFromDisk).mock.calls.length;
      observedStateAtLoad = result.current.vaultState;
      return 0;
    });

    await act(async () => {
      await result.current.unlockVault('correct');
    });

    expect(observedTranscriptCallCount).toBeGreaterThan(0);
    expect(observedStateAtLoad).not.toBe('unlocked');
    expect(result.current.vaultState).toBe('unlocked');
  });
});

describe('useAuth - PIN attempt counter wipe after MAX_PIN_FAILURES', () => {
  it('stores failed PIN attempts in IDB and survives localStorage clearing', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await act(async () => { await result.current.setPIN('pin'); });
    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));

    await act(async () => {
      await expect(result.current.unlockVault('wrong')).rejects.toMatchObject({
        code: 'WRONG_PIN',
      });
    });
    localStorage.removeItem('hush_pin_attempts_user-1');

    await act(async () => {
      await expect(result.current.unlockVault('wrong')).rejects.toMatchObject({
        code: 'WRONG_PIN',
      });
    });

    expect(vaultMod.savePinAttemptsToIDB).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ count: 2 }),
    );
    expect(localStorage.getItem('hush_pin_attempts_user-1')).toBeNull();
  });

  it('charges a failed PIN attempt before decrypting the vault blob', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await act(async () => { await result.current.setPIN('pin'); });
    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));
    vi.mocked(vaultMod.savePinAttemptsToIDB).mockClear();
    vi.mocked(vaultMod.decryptVaultAndExportKey).mockClear();

    await act(async () => {
      await expect(result.current.unlockVault('wrong')).rejects.toMatchObject({
        code: 'WRONG_PIN',
      });
    });

    const saveOrder = vi.mocked(vaultMod.savePinAttemptsToIDB).mock.invocationCallOrder[0];
    const decryptOrder = vi.mocked(vaultMod.decryptVaultAndExportKey).mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(decryptOrder);
  });

  it('wipes vault after 10 failures and throws VAULT_WIPED', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));

    await act(async () => { await result.current.setPIN('pin'); });
    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));

    vi.useFakeTimers();
    _pinAttempts.set('user-1', {
      count: 9,
      lastAttemptAt: new Date().toISOString(),
    });

    let caught;
    await act(async () => {
      const unlockPromise = result.current.unlockVault('wrong').catch((err) => {
        caught = err;
      });
      await vi.advanceTimersByTimeAsync(61_000);
      await unlockPromise;
    });
    vi.useRealTimers();

    expect(caught?.code).toBe('VAULT_WIPED');
    expect(result.current.vaultState).toBe('none');
    expect(vaultMod.deleteVaultDatabase).toHaveBeenCalledWith('user-1');
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
    // PIN brute-force wipe must also remove the persisted vault
    // marker so a subsequent boot does not believe a vault still
    // exists and offer a PIN screen we can no longer satisfy.
    expect(localStorage.getItem('hush_vault_user_user-1')).toBeNull();
    expect(localStorage.getItem('hush_pin_attempts_user-1')).toBeNull();
    expect(result.current.hasVault).toBe(false);
  }, 15_000);
});

describe('useAuth - performLogout', () => {
  it('clears all storage and resets state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // Seed some storage to verify wipe.
    localStorage.setItem('test_key', 'test_value');
    sessionStorage.setItem('test_key', 'test_value');
    seedAuthOwnedQueryData();

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue({ ok: true, status: 204 });

    await act(async () => {
      await result.current.performLogout();
    });

    expectLocalAuthResetState(result.current);
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
    expect(localStorage.getItem('test_key')).toBeNull();
    expect(sessionStorage.getItem('test_key')).toBeNull();
    expectAuthOwnedQueryDataCleared();
  });

  it('clears auth-owned query data when another tab broadcasts logout', async () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    MockBroadcastChannel.instances = [];
    globalThis.BroadcastChannel = MockBroadcastChannel;

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.performChallengeResponse(
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(2),
        );
      });
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
      seedAuthOwnedQueryData();

      await act(async () => {
        const sender = new BroadcastChannel('hush_auth');
        sender.postMessage({ type: 'hush_logout' });
        sender.close();
      });

      expect(result.current.token).toBeNull();
      expect(result.current.user).toBeNull();
      expectAuthOwnedQueryDataCleared();
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
      MockBroadcastChannel.instances = [];
    }
  });

  it('does not delete persisted vault material when another tab broadcasts logout', async () => {
    // Broadcast logout is a local session reset, not a vault wipe.
    // The signed-out tab discards in-memory + auth-owned query state,
    // but the local vault marker and IndexedDB rows must survive so
    // the next PIN unlock can still rehydrate the user.
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    MockBroadcastChannel.instances = [];
    globalThis.BroadcastChannel = MockBroadcastChannel;

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.performChallengeResponse(
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(2),
        );
      });
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
      expect(localStorage.getItem('hush_vault_user_user-1')).not.toBeNull();

      vi.mocked(vaultMod.deleteVaultDatabase).mockClear();
      vi.mocked(transcriptVaultMod.deleteTranscriptDatabase).mockClear();

      await act(async () => {
        const sender = new BroadcastChannel('hush_auth');
        sender.postMessage({ type: 'hush_logout' });
        sender.close();
      });

      expect(result.current.token).toBeNull();
      expect(result.current.user).toBeNull();
      // Vault material survives the broadcast — only auth state was reset.
      expect(localStorage.getItem('hush_vault_user_user-1')).not.toBeNull();
      expect(vaultMod.deleteVaultDatabase).not.toHaveBeenCalled();
      expect(transcriptVaultMod.deleteTranscriptDatabase).not.toHaveBeenCalled();
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
      MockBroadcastChannel.instances = [];
    }
  });

  it('fully resets guest and stale error state when another tab broadcasts logout', async () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    MockBroadcastChannel.instances = [];
    globalThis.BroadcastChannel = MockBroadcastChannel;

    try {
      const expiresAtMs = Date.now() + 60 * 60 * 1000;
      const guestToken = buildFakeJwt({
        sub: 'guest_abc123',
        sid: 'sess-guest-1',
        is_guest: true,
        exp: Math.floor(expiresAtMs / 1000),
      });
      vi.mocked(apiMod.requestGuestSession).mockResolvedValue({
        token: guestToken,
        guestId: 'guest_abc123',
        expiresAt: new Date(expiresAtMs).toISOString(),
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.performGuestAuth();
      });
      expect(result.current.isGuest).toBe(true);
      expect(result.current.guestExpiresAt).not.toBeNull();
      expect(sessionStorage.getItem(JWT_KEY)).toBe(guestToken);

      vi.mocked(apiMod.requestGuestSession).mockRejectedValueOnce(new Error('guest retry failed'));
      await act(async () => {
        try { await result.current.performGuestAuth(); } catch { /* expected */ }
      });
      expect(result.current.error).toBeInstanceOf(Error);

      seedAuthOwnedQueryData();

      await act(async () => {
        const sender = new BroadcastChannel('hush_auth');
        sender.postMessage({ type: 'hush_logout' });
        sender.close();
      });

      expectLocalAuthResetState(result.current);
      expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
      expectAuthOwnedQueryDataCleared();
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
      MockBroadcastChannel.instances = [];
    }
  });

  it('clears the cross-reload session key store on scorched-earth logout (P21 step 4)', async () => {
    // Without this contract, signing out would leave the IDB session
    // DB and the per-tab marker behind — leaking the previous user's
    // session to whoever opens the tab next.
    vi.mocked(apiMod.verifyChallenge).mockResolvedValueOnce({
      token: 'jwt-logout-user',
      user: { id: 'logout-user', username: 'logout', displayName: 'Logout' },
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await waitFor(
      async () => {
        expect(await readWrappedIdentity('logout-user')).not.toBeNull();
      },
      { timeout: 3000 },
    );

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue({ ok: true, status: 204 });
    await act(async () => {
      await result.current.performLogout();
    });

    // The session-key wipe is fire-and-forget so the logout UX never
    // blocks on IDB; the IDB deleteDatabase resolves on a later tick.
    await waitFor(
      async () => {
        expect(await readWrappedIdentity('logout-user')).toBeNull();
      },
      { timeout: 3000 },
    );
    expect(isMarkerAlive('logout-user')).toBe(false);
  });

  it('calls deleteVaultDatabase for the logged-in user', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.user?.id).toBe('user-1'));

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue({ ok: true, status: 204 });

    await act(async () => {
      await result.current.performLogout();
    });

    expect(vaultMod.deleteVaultDatabase).toHaveBeenCalledWith('user-1');
  });

  it('proceeds with full local wipe even if server call fails', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    vi.mocked(apiMod.fetchWithAuth).mockRejectedValue(new Error('network error'));

    let threw = false;
    await act(async () => {
      try { await result.current.performLogout(); } catch { threw = true; }
    });

    expect(threw).toBe(false);
    expect(result.current.vaultState).toBe('none');
  });
});

describe('useAuth - session rehydration', () => {
  it('sets vaultState=locked when JWT exists but session flag is absent (vault blob exists)', async () => {
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem('hush_vault_user_user-42', 'aabb');
    // No VAULT_SESSION_FLAG.

    // Vault blob must exist in IDB - otherwise it's a stale marker (PIN never set).
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set('user-42', fakeBlob);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-42', username: 'eve', displayName: 'Eve' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.hasSession).toBe(true);
    expect(result.current.isVaultUnlocked).toBe(false);
    expect(result.current.needsUnlock).toBe(true);
  });

  it('sets vaultState=unlocked when vault marker exists but no blob (PIN never set)', async () => {
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem('hush_vault_user_user-42', 'aabb');
    // No blob in _vaultBlobs - simulates registration without PIN setup.

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-42', username: 'eve', displayName: 'Eve' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('unlocked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.hasSession).toBe(true);
    expect(result.current.isVaultUnlocked).toBe(false);
    expect(result.current.needsUnlock).toBe(true);
    // Stale marker should be cleared.
    expect(localStorage.getItem('hush_vault_user_user-42')).toBeNull();
  });

  it('preserves pending pin setup across refresh when JWT is still valid', async () => {
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    sessionStorage.setItem('hush_pin_setup_pending', '1');

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-42', username: 'eve', displayName: 'Eve' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('unlocked');
    expect(result.current.needsPinSetup).toBe(true);
  });

  it('resumes vaultState=unlocked from the session-key store under "never" with valid JWT (P21 step 3)', async () => {
    // Pre-seed the cross-reload session key store as if a previous
    // unlock had already sealed the identity. With a `never` policy
    // and a still-valid JWT, the boot effect must resume directly to
    // `vaultState='unlocked'` without prompting for PIN.
    const userId = 'user-step3-never';
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem(`hush_vault_user_${userId}`, 'aabb');
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set(userId, fakeBlob);

    vi.mocked(vaultMod.getVaultConfig).mockReturnValue({
      timeout: 'never',
      pinType: 'pin',
    });

    await clearSessionKey(userId);
    const identityBytes = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        priv: Array.from(new Uint8Array(32).fill(7)),
        pub: Array.from(new Uint8Array(32).fill(8)),
      }),
    );
    await sealIdentityIntoSession(userId, identityBytes);
    // No alive marker — `never` must not consult it.

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: userId, username: 'fox', displayName: 'Fox' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));
    expect(result.current.hasVault).toBe(true);
    expect(result.current.isVaultUnlocked).toBe(true);
    expect(result.current.needsUnlock).toBe(false);
  });

  it('does NOT resume from the session-key store under "browser_close" when no marker and no sibling tab is alive (P21 step 3)', async () => {
    // browser_close survives soft refresh inside the same tab (marker
    // present) but not a cold tab open. With marker absent the boot
    // must fall back to PIN.
    const userId = 'user-step3-bc';
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem(`hush_vault_user_${userId}`, 'aabb');
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set(userId, fakeBlob);

    vi.mocked(vaultMod.getVaultConfig).mockReturnValue({
      timeout: 'browser_close',
      pinType: 'pin',
    });

    await clearSessionKey(userId);
    await sealIdentityIntoSession(
      userId,
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          priv: Array.from(new Uint8Array(32).fill(7)),
          pub: Array.from(new Uint8Array(32).fill(8)),
        }),
      ),
    );
    // No marker, no sibling — refcount probe returns false.

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: userId, username: 'gus', displayName: 'Gus' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vaultState).toBe('locked');
    expect(result.current.needsUnlock).toBe(true);
  });

  it('wipes the session-key store at boot under "refresh" policy (P21 step 4)', async () => {
    // `refresh` semantically demands a fresh PIN on every reload, so
    // the IDB session DB must be wiped proactively. Otherwise it
    // persists as dead disk data and a switch *to* `refresh` from a
    // more permissive policy would leave a stale entry sitting until
    // the next sign-out.
    const userId = 'user-step4-refresh';
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem(`hush_vault_user_${userId}`, 'aabb');
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set(userId, fakeBlob);

    vi.mocked(vaultMod.getVaultConfig).mockReturnValue({
      timeout: 'refresh',
      pinType: 'pin',
    });

    await clearSessionKey(userId);
    await sealIdentityIntoSession(
      userId,
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          priv: Array.from(new Uint8Array(32).fill(7)),
          pub: Array.from(new Uint8Array(32).fill(8)),
        }),
      ),
    );
    expect(await readWrappedIdentity(userId)).not.toBeNull();

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: userId, username: 'iris', displayName: 'Iris' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vaultState).toBe('locked');

    // Boot wipe: refresh policy must have removed the IDB record.
    await waitFor(async () => {
      expect(await readWrappedIdentity(userId)).toBeNull();
    });
  });

  it('does NOT resume from the session-key store when a numeric timeout deadline expired while closed', async () => {
    const userId = 'user-step4-expired-numeric';
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem(`hush_vault_user_${userId}`, 'aabb');
    localStorage.setItem(`hush_vault_idle_deadline_${userId}`, String(Date.now() - 1));
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set(userId, fakeBlob);

    vi.mocked(vaultMod.getVaultConfig).mockReturnValue({
      timeout: 5,
      pinType: 'pin',
    });

    await clearSessionKey(userId);
    await sealIdentityIntoSession(
      userId,
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          priv: Array.from(new Uint8Array(32).fill(7)),
          pub: Array.from(new Uint8Array(32).fill(8)),
        }),
      ),
    );
    expect(await readWrappedIdentity(userId)).not.toBeNull();

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: userId, username: 'nova', displayName: 'Nova' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vaultState).toBe('locked');
    expect(result.current.needsUnlock).toBe(true);

    await waitFor(async () => {
      expect(await readWrappedIdentity(userId)).toBeNull();
    });
    expect(localStorage.getItem(`hush_vault_idle_deadline_${userId}`)).toBeNull();
  });

  it('resumes from the session-key store under "browser_close" when the per-tab alive marker is set (P21 step 3)', async () => {
    // Same as above, but with an alive marker — soft refresh inside
    // the same tab. Must resume to `vaultState='unlocked'`.
    const userId = 'user-step3-bc-alive';
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem(`hush_vault_user_${userId}`, 'aabb');
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set(userId, fakeBlob);

    vi.mocked(vaultMod.getVaultConfig).mockReturnValue({
      timeout: 'browser_close',
      pinType: 'pin',
    });

    await clearSessionKey(userId);
    await sealIdentityIntoSession(
      userId,
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          priv: Array.from(new Uint8Array(32).fill(7)),
          pub: Array.from(new Uint8Array(32).fill(8)),
        }),
      ),
    );
    markVaultSessionAlive(userId);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: userId, username: 'hank', displayName: 'Hank' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));
  });

  it('does not auto-unlock vault from leftover sessionStorage wrapping key (ans23 / F3)', async () => {
    // ans23 removed the at-rest persistence of the vault wrapping key.
    // Even when an old install left `hush_vault_derived_key` in
    // sessionStorage, the hook must NOT auto-decrypt the vault — the
    // user must re-enter their PIN. The leftover key must be purged so
    // a same-origin script cannot read it.
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    sessionStorage.setItem('hush_vault_session_alive', '1');
    sessionStorage.setItem('hush_vault_derived_key', 'aabbccdd');
    localStorage.setItem('hush_vault_user_user-43', 'aabb');

    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set('user-43', fakeBlob);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-43', username: 'frank', displayName: 'Frank' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.isVaultUnlocked).toBe(false);
    expect(result.current.needsUnlock).toBe(true);
    expect(sessionStorage.getItem('hush_vault_derived_key')).toBeNull();
  });

  it('migrates the legacy global vault timeout key into the per-user config on startup', async () => {
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem('hush_vault_timeout', '15m');
    localStorage.setItem('hush_vault_user_user-43', 'aabb');

    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set('user-43', fakeBlob);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-43', username: 'frank', displayName: 'Frank' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Migration runs on authenticated startup independent of unlock state
    // (ans23: auto-unlock from sessionStorage is removed, but we still
    // want the legacy preference to land on the per-user config).
    expect(vaultMod.setVaultConfig).toHaveBeenCalledWith(
      'user-43',
      { timeout: 15, pinType: 'pin' },
    );
    expect(localStorage.getItem('hush_vault_timeout')).toBeNull();
    // Vault remains locked until PIN is entered.
    expect(result.current.vaultState).toBe('locked');
  });

  it('sets vaultState=locked when JWT and session flag exist but derived key is absent (vault blob exists)', async () => {
    // Session alive but no derived key - vault timeout='refresh' cleared it,
    // or this is the first load after browser restart. Must prompt for PIN.
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    sessionStorage.setItem('hush_vault_session_alive', '1');
    // No hush_vault_derived_key set.
    localStorage.setItem('hush_vault_user_user-43', 'aabb');

    // Vault blob must exist - otherwise it's a stale marker.
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set('user-43', fakeBlob);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-43', username: 'frank', displayName: 'Frank' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.needsUnlock).toBe(true);
  });

  it('falls back to locked if stored derived key fails to decrypt', async () => {
    // Derived key in sessionStorage is corrupt or stale - auto-unlock fails,
    // should fall back to PIN screen.
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    sessionStorage.setItem('hush_vault_session_alive', '1');
    sessionStorage.setItem('hush_vault_derived_key', 'bad-key');
    localStorage.setItem('hush_vault_user_user-43', 'aabb');

    const fakeBlob = new Uint8Array(44);
    _vaultBlobs.set('user-43', fakeBlob);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: 'user-43', username: 'frank', displayName: 'Frank' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.needsUnlock).toBe(true);
    // Bad key should be cleared from sessionStorage.
    expect(sessionStorage.getItem('hush_vault_derived_key')).toBeNull();
  });

  it('sets vaultState=none when JWT is invalid (401)', async () => {
    sessionStorage.setItem(JWT_KEY, 'bad-jwt');
    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('none');
    expect(result.current.hasVault).toBe(false);
    expect(result.current.hasSession).toBe(false);
    expect(result.current.needsUnlock).toBe(false);
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
  });

  it('routes an invalid server session above PIN when a local vault exists', async () => {
    sessionStorage.setItem(JWT_KEY, 'stale-jwt');
    localStorage.setItem('hush_vault_user_user-43', 'aabb');
    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.authInvalidation?.reason).toBe('server_session_invalid');
    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.needsUnlock).toBe(false);
    expect(localStorage.getItem('hush_vault_user_user-43')).toBe('aabb');
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
  });

  it('sets vaultState=none when no JWT present', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('none');
    expect(result.current.hasVault).toBe(false);
    expect(result.current.hasSession).toBe(false);
    expect(result.current.needsUnlock).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('reports hasVault and needsUnlock when no JWT is present but a local vault exists', async () => {
    localStorage.setItem('hush_vault_user_user-77', 'aabb');
    vi.mocked(vaultMod.checkVaultExistsInIDB).mockResolvedValueOnce({ exists: true, publicKeyHex: 'aabb' });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.hasSession).toBe(false);
    expect(result.current.isVaultUnlocked).toBe(false);
    expect(result.current.needsUnlock).toBe(true);
  });

  it('still requires PIN when a stale authInvalidation marker is present alongside a valid session', async () => {
    // Regression for PR #19: a persisted `hush_auth_invalidation` marker
    // must NOT short-circuit the PIN gate when there is still a live
    // JWT/user session. Otherwise a stale or planted marker would route
    // an authenticated browser into the app while the local vault is
    // locked.
    const userId = 'user-stale-invalidation';
    sessionStorage.setItem(JWT_KEY, 'valid-jwt');
    localStorage.setItem(`hush_vault_user_${userId}`, 'aabb');
    localStorage.setItem(
      'hush_auth_invalidation',
      JSON.stringify({ reason: 'server_session_invalid', at: '2026-05-15T00:00:00Z' }),
    );

    // Vault blob must exist in IDB so the locked-vault path resolves.
    const fakeBlob = new Uint8Array(44);
    fakeBlob.set(new Uint8Array(32).fill(1), 12);
    _vaultBlobs.set(userId, fakeBlob);

    vi.mocked(apiMod.fetchWithAuth).mockResolvedValue(
      mockFetchOk({ id: userId, username: 'eve', displayName: 'Eve' }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasSession).toBe(true);
    expect(result.current.authInvalidation?.reason).toBe('server_session_invalid');
    expect(result.current.hasVault).toBe(true);
    expect(result.current.isVaultUnlocked).toBe(false);
    expect(result.current.needsUnlock).toBe(true);
  });
});

describe('useAuth - setPIN', () => {
  it('encrypts and saves key after unlock', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister('newuser', 'New User', 'word '.repeat(12).trim());
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));
    expect(result.current.needsPinSetup).toBe(true);

    await act(async () => {
      await result.current.setPIN('my-secret-pin');
    });

    expect(vaultMod.encryptVault).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'my-secret-pin',
    );
    expect(vaultMod.saveEncryptedKey).toHaveBeenCalled();
    expect(result.current.needsPinSetup).toBe(false);
  });

  it('throws if called without identity key in memory', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let caught;
    await act(async () => {
      try { await result.current.setPIN('pin'); } catch (err) { caught = err; }
    });

    expect(caught?.message).toMatch(/no identity key/i);
  });

  it('rotates the cross-reload session key store on PIN change (P21 step 4)', async () => {
    // PIN change must invalidate the existing CryptoKey so any stolen
    // copy of the IDB record from before the change becomes useless.
    // Verify by sealing once, capturing the wrapped bundle, calling
    // setPIN, and asserting the stored bundle differs.
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister(
        'rotateuser',
        'Rotate User',
        'word '.repeat(12).trim(),
      );
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));

    // Wait for the fire-and-forget unlock seal.
    let beforeBundle = null;
    await waitFor(async () => {
      beforeBundle = await readWrappedIdentity(result.current.user.id);
      expect(beforeBundle).not.toBeNull();
    });

    await act(async () => {
      await result.current.setPIN('first-pin');
    });

    // The PIN-change re-seal is also fire-and-forget.
    await waitFor(async () => {
      const afterBundle = await readWrappedIdentity(result.current.user.id);
      expect(afterBundle).not.toBeNull();
      // Different IV per AES-GCM seal proves a fresh wrap actually
      // ran; under rotation the underlying CryptoKey rotates too.
      expect(Array.from(afterBundle.iv)).not.toEqual(
        Array.from(beforeBundle.iv),
      );
    });
  });
});

describe('useAuth - skipPinSetup', () => {
  it('clears the pending pin-setup state without logging out', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRegister('newuser', 'New User', 'word '.repeat(12).trim());
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.needsPinSetup).toBe(true);

    act(() => {
      result.current.skipPinSetup();
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.needsPinSetup).toBe(false);
  });
});

describe('useAuth - lockVault', () => {
  it('sets vaultState=locked without deleting vault data', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));

    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));

    expect(vaultMod.deleteVaultDatabase).not.toHaveBeenCalled();
  });

  it('clears the cross-reload session key store on manual lock (P21 step 4)', async () => {
    // Without this contract, pressing "Lock" then reloading would
    // resume from IDB and silently undo the lock.
    vi.mocked(apiMod.verifyChallenge).mockResolvedValueOnce({
      token: 'jwt-lock-user',
      user: { id: 'lock-user', username: 'lock', displayName: 'Lock' },
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));
    // Wait for fire-and-forget seal to land before locking.
    await waitFor(
      async () => {
        expect(await readWrappedIdentity('lock-user')).not.toBeNull();
      },
      { timeout: 3000 },
    );

    act(() => result.current.lockVault());
    await waitFor(() => expect(result.current.vaultState).toBe('locked'));

    // The IDB record + per-tab marker must both be wiped.
    await waitFor(
      async () => {
        expect(await readWrappedIdentity('lock-user')).toBeNull();
      },
      { timeout: 3000 },
    );
    expect(isMarkerAlive('lock-user')).toBe(false);
  });

  it('removes a stale refresh handler when vault timeout changes while unlocked', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.vaultState).toBe('unlocked'));

    sessionStorage.setItem('hush_vault_derived_key', 'secret');

    act(() => {
      result.current.updateVaultTimeout('refresh');
    });

    act(() => {
      result.current.updateVaultTimeout('browser_close');
    });

    window.dispatchEvent(new Event('beforeunload'));

    expect(vaultMod.setVaultConfig).toHaveBeenNthCalledWith(
      1,
      'user-1',
      { timeout: 'refresh', pinType: 'pin' },
    );
    expect(vaultMod.setVaultConfig).toHaveBeenNthCalledWith(
      2,
      'user-1',
      { timeout: 'browser_close', pinType: 'pin' },
    );
    expect(sessionStorage.getItem('hush_vault_derived_key')).toBe('secret');
  });
});

// ── Guest session ──────────────────────────────────────────────────────────────

describe('useAuth - guest session', () => {
  /**
   * Builds a fake JWT with is_guest=true and the given expiry.
   * The client reads claims from the payload only (no sig verification).
   */
  function makeGuestJwt(expiresAtMs) {
    const payload = {
      sub: 'guest_abc123',
      sid: 'sess-guest-1',
      is_guest: true,
      exp: Math.floor(expiresAtMs / 1000),
      iat: Math.floor(Date.now() / 1000),
    };
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = btoa(JSON.stringify(payload));
    return `${header}.${body}.fake-sig`;
  }

  it('performGuestAuth sets isGuest=true and guestExpiresAt', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const guestToken = makeGuestJwt(new Date(expiresAt).getTime());
    vi.mocked(apiMod.requestGuestSession).mockResolvedValue({
      token: guestToken,
      guestId: 'guest_abc123',
      expiresAt,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performGuestAuth();
    });

    expect(result.current.isGuest).toBe(true);
    expect(result.current.guestExpiresAt).toBe(expiresAt);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.hasSession).toBe(true);
    expect(result.current.hasVault).toBe(false);
    expect(result.current.needsUnlock).toBe(false);
    expect(result.current.vaultState).toBe('unlocked');
  });

  it('guest JWT with T-5min remaining triggers hush_guest_expiry_warning event', async () => {
    // Expires in exactly 5 minutes - warning fires immediately (warningMs <= 0).
    const expiresAtMs = Date.now() + 5 * 60 * 1000;
    const guestToken = makeGuestJwt(expiresAtMs);
    vi.mocked(apiMod.requestGuestSession).mockResolvedValue({
      token: guestToken,
      guestId: 'guest_abc123',
      expiresAt: new Date(expiresAtMs).toISOString(),
    });

    const warningHandler = vi.fn();
    window.addEventListener('hush_guest_expiry_warning', warningHandler);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performGuestAuth();
    });

    // The warning fires synchronously when <= 5 min remaining.
    expect(warningHandler).toHaveBeenCalledOnce();
    window.removeEventListener('hush_guest_expiry_warning', warningHandler);
  });

  it('guest session expiry fires hush_guest_session_expired event and resets state', async () => {
    // Very short expiry so we can use real timers with a short wait.
    const expiresAtMs = Date.now() + 300;
    const guestToken = makeGuestJwt(expiresAtMs);
    vi.mocked(apiMod.requestGuestSession).mockResolvedValue({
      token: guestToken,
      guestId: 'guest_abc123',
      expiresAt: new Date(expiresAtMs).toISOString(),
    });

    const expiredHandler = vi.fn();
    window.addEventListener('hush_guest_session_expired', expiredHandler);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performGuestAuth();
    });

    expect(result.current.isGuest).toBe(true);

    // Wait for the expiry timer to fire (300ms).
    await waitFor(() => expect(expiredHandler).toHaveBeenCalledOnce(), { timeout: 3000 });
    await waitFor(() => expect(result.current.isGuest).toBe(false), { timeout: 3000 });
    expect(result.current.isAuthenticated).toBe(false);

    window.removeEventListener('hush_guest_session_expired', expiredHandler);
  }, 10_000);

  it('performGuestAuth failure resets state', async () => {
    vi.mocked(apiMod.requestGuestSession).mockRejectedValueOnce(new Error('server error'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      try { await result.current.performGuestAuth(); } catch { /* expected */ }
    });

    expect(result.current.isGuest).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.vaultState).toBe('none');
  });
});

// ── Per-instance JWT storage ───────────────────────────────────────────────────

describe('useAuth - per-instance JWT storage', () => {
  it('setInstanceToken stores at the host-namespaced key', () => {
    setInstanceToken('https://chat.example.com', 'token-a');
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('token-a');
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
  });

  it('getInstanceToken reads from the host-namespaced key', () => {
    sessionStorage.setItem('hush_jwt_chat.example.com', 'token-b');
    expect(getInstanceToken('https://chat.example.com')).toBe('token-b');
  });

  it('getLocalToken reads from the active instance namespaced key', () => {
    _mockActiveInstanceUrl = 'https://chat.example.com';
    sessionStorage.setItem('hush_jwt_chat.example.com', 'token-active');
    expect(getLocalToken()).toBe('token-active');
  });

  it('clearSession removes all hush_jwt_* keys', () => {
    sessionStorage.setItem('hush_jwt_chat.example.com', 'token-a');
    sessionStorage.setItem('hush_jwt_other.host.net', 'token-b');
    sessionStorage.setItem(JWT_KEY, 'token-legacy');
    sessionStorage.setItem('hush_vault_session_alive', '1');
    clearSession();
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBeNull();
    expect(sessionStorage.getItem('hush_jwt_other.host.net')).toBeNull();
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
    // Non-JWT keys should not be touched by clearSession (vault session flag cleared separately).
  });

  it('legacy migration: hush_jwt migrated to namespaced key on first getLocalToken read', () => {
    _mockActiveInstanceUrl = 'https://chat.example.com';
    sessionStorage.setItem(JWT_KEY, 'legacy-token');
    const token = getLocalToken();
    expect(token).toBe('legacy-token');
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('legacy-token');
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
  });

  it('two instances can store and retrieve different tokens simultaneously', () => {
    setInstanceToken('https://instance-a.com', 'jwt-a');
    setInstanceToken('https://instance-b.com', 'jwt-b');
    expect(getInstanceToken('https://instance-a.com')).toBe('jwt-a');
    expect(getInstanceToken('https://instance-b.com')).toBe('jwt-b');
    expect(getInstanceToken('https://instance-a.com')).not.toBe(getInstanceToken('https://instance-b.com'));
  });

  it('getInstanceToken returns null when only the legacy hush_jwt key exists (no namespaced for target)', () => {
    // Legacy global is present but no namespaced key for the target
    // instance. The explicit-target lookup must NOT fall back — that
    // would route the legacy token to the wrong origin.
    sessionStorage.setItem(JWT_KEY, 'legacy-only-token');
    expect(getInstanceToken('https://chat.example.com')).toBeNull();
    expect(sessionStorage.getItem(JWT_KEY)).toBe('legacy-only-token');
  });

  it('getInstanceToken returns the namespaced token and ignores an unrelated legacy token', () => {
    sessionStorage.setItem(JWT_KEY, 'legacy-token');
    sessionStorage.setItem('hush_jwt_chat.example.com', 'namespaced-token');
    expect(getInstanceToken('https://chat.example.com')).toBe('namespaced-token');
    expect(getTokenForInstanceUrl('https://chat.example.com')).toBe('namespaced-token');
  });

  it('getInstanceToken returns null (not legacy) when the instance URL is malformed', () => {
    // The malformed-URL path used to fall back to the legacy global
    // slot, leaking the token to any unspecified target.
    sessionStorage.setItem(JWT_KEY, 'legacy-token');
    expect(getInstanceToken('not-a-url')).toBeNull();
    expect(getTokenForInstanceUrl('not-a-url')).toBeNull();
  });

  it('getInstanceToken rejects desktop app origins', () => {
    sessionStorage.setItem('hush_jwt_localhost', 'desktop-origin-token');
    expect(getInstanceToken('app://localhost')).toBeNull();
    expect(getTokenForInstanceUrl('app://localhost')).toBeNull();
  });

  it('migrates a desktop app-origin token to the hosted instance on local token read', () => {
    Object.defineProperty(window, 'hushDesktop', {
      configurable: true,
      value: { isDesktop: true },
    });
    _mockActiveInstanceUrl = 'https://app.gethush.live';
    sessionStorage.setItem('hush_jwt_localhost', 'desktop-origin-token');

    expect(getLocalToken()).toBe('desktop-origin-token');
    expect(sessionStorage.getItem('hush_jwt_app.gethush.live')).toBe('desktop-origin-token');
    expect(sessionStorage.getItem('hush_jwt_localhost')).toBeNull();

    delete window.hushDesktop;
  });

  it('setInstanceToken clears any stale legacy hush_jwt after writing the namespaced key', () => {
    sessionStorage.setItem(JWT_KEY, 'old-legacy');
    setInstanceToken('https://chat.example.com', 'fresh-namespaced');
    expect(sessionStorage.getItem('hush_jwt_chat.example.com')).toBe('fresh-namespaced');
    expect(sessionStorage.getItem(JWT_KEY)).toBeNull();
  });

  it('setInstanceToken is a no-op for non-HTTP origins', () => {
    sessionStorage.setItem(JWT_KEY, 'preserved-legacy');
    setInstanceToken('app://localhost', 'should-not-write');
    expect(sessionStorage.getItem(JWT_KEY)).toBe('preserved-legacy');
    expect(sessionStorage.getItem('hush_jwt_localhost')).toBeNull();
  });

  it('getLocalToken does NOT migrate legacy to namespaced when no active instance is set', () => {
    _mockActiveInstanceUrl = '';
    sessionStorage.setItem(JWT_KEY, 'legacy-no-active');
    // Returned for boot-time profile lookups, but the legacy slot is
    // intentionally NOT moved into a namespaced bucket because there
    // is no concrete instance to scope it to.
    expect(getLocalToken()).toBe('legacy-no-active');
    expect(sessionStorage.getItem(JWT_KEY)).toBe('legacy-no-active');
  });

  it('getLocalToken does not read or write a null storage key for non-HTTP active instance URLs', () => {
    _mockActiveInstanceUrl = 'app://localhost';
    sessionStorage.setItem('null', 'poison');
    sessionStorage.setItem(JWT_KEY, 'legacy-token');

    expect(getLocalToken()).toBe('legacy-token');
    expect(sessionStorage.getItem('null')).toBe('poison');
    expect(sessionStorage.getItem(JWT_KEY)).toBe('legacy-token');
  });
});

// ── J.1-03: performRecovery sets post-recovery wizard flag ─────────────────────

describe('useAuth - performRecovery', () => {
  it('sets hush_post_recovery_wizard localStorage flag after successful recovery', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Ensure flag is absent before recovery
    expect(localStorage.getItem('hush_post_recovery_wizard')).toBeNull();

    await act(async () => {
      await result.current.performRecovery('word '.repeat(12).trim(), false);
    });

    expect(localStorage.getItem('hush_post_recovery_wizard')).toBe('1');
  });

  it('sets hush_post_recovery_wizard flag even when revokeOtherDevices=true', async () => {
    // listDeviceKeys and revokeDeviceKey are already mocked in the top-level module mocks.
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRecovery('word '.repeat(12).trim(), true);
    });

    expect(localStorage.getItem('hush_post_recovery_wizard')).toBe('1');
  });

  it('marks cached device-key queries stale after revokeOtherDevices=true', async () => {
    vi.mocked(apiMod.listDeviceKeys).mockResolvedValueOnce([
      { id: 'k-1', deviceId: 'device-current', certifiedAt: '2026-01-01T00:00:00Z' },
      { id: 'k-2', deviceId: 'device-other', certifiedAt: '2026-01-01T00:00:00Z' },
    ]);
    const deviceKey = ['auth', 'devices', 'https://i.example.com', 'user-1'];
    queryClient.setQueryData(deviceKey, [
      { id: 'k-1', deviceId: 'device-current', certifiedAt: '2026-01-01T00:00:00Z' },
      { id: 'k-2', deviceId: 'device-other', certifiedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(queryClient.getQueryState(deviceKey)?.isInvalidated).toBe(false);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRecovery('word '.repeat(12).trim(), true);
    });

    expect(queryClient.getQueryState(deviceKey)?.isInvalidated).toBe(true);
  });

  it('scopes recovery bulk revoke to the recovery baseUrl', async () => {
    const recoveryBaseUrl = 'https://chat.example.com';
    // Pin the local device id so the filter that excludes the current
    // device leaves exactly the foreign row in the revoke set.
    localStorage.setItem('hush_device_id', 'device-current');
    vi.mocked(apiMod.listDeviceKeys).mockClear();
    vi.mocked(apiMod.revokeDeviceKey).mockClear();
    vi.mocked(apiMod.listDeviceKeys).mockResolvedValueOnce([
      { id: 'k-1', deviceId: 'device-current', certifiedAt: '2026-01-01T00:00:00Z' },
      { id: 'k-2', deviceId: 'device-other', certifiedAt: '2026-01-01T00:00:00Z' },
    ]);
    vi.mocked(apiMod.revokeDeviceKey).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.performRecovery(
        'word '.repeat(12).trim(),
        true,
        recoveryBaseUrl,
      );
    });

    const listCall = vi.mocked(apiMod.listDeviceKeys).mock.calls.at(-1);
    expect(listCall?.[1]).toBe(recoveryBaseUrl);

    const revokeCalls = vi.mocked(apiMod.revokeDeviceKey).mock.calls;
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0][1]).toBe('device-other');
    expect(revokeCalls[0][2]).toBe(recoveryBaseUrl);
  });

  it('does NOT set hush_post_recovery_wizard flag when recovery fails', async () => {
    vi.mocked(apiMod.verifyChallenge).mockRejectedValueOnce(new Error('unauthorized'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      try {
        await result.current.performRecovery('word '.repeat(12).trim(), false);
      } catch {
        // expected to throw
      }
    });

    expect(localStorage.getItem('hush_post_recovery_wizard')).toBeNull();
  });
});

describe('useAuth - forced logout on revoked-device signal', () => {
  it('does not restore a leftover IndexedDB vault after persisted device revocation', async () => {
    localStorage.setItem(
      'hush_auth_invalidation',
      JSON.stringify({ reason: 'device_revoked', at: '2026-05-19T00:00:00Z' }),
    );
    localStorage.setItem('hush_vault_user__last_user', 'user-1');
    vi.mocked(vaultMod.checkVaultExistsInIDB).mockResolvedValueOnce({
      exists: true,
      publicKeyHex: 'aabb',
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.authInvalidation?.reason).toBe('device_revoked');
    expect(result.current.vaultState).toBe('none');
    expect(result.current.hasVault).toBe(false);
    expect(result.current.needsUnlock).toBe(false);
    expect(localStorage.getItem('hush_vault_user__last_user')).toBeNull();
    expect(vaultMod.deleteVaultDatabase).toHaveBeenCalledWith('user-1');
  });

  it('does not rewrite an existing revoked-device invalidation tombstone on boot', async () => {
    localStorage.setItem(
      'hush_auth_invalidation',
      JSON.stringify({ reason: 'device_revoked', at: '2026-05-19T00:00:00Z' }),
    );
    localStorage.setItem('hush_vault_user__last_user', 'user-1');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    setItemSpy.mockClear();

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(setItemSpy).not.toHaveBeenCalledWith(
        'hush_auth_invalidation',
        expect.any(String),
      );
      expect(result.current.authInvalidation?.reason).toBe('device_revoked');
      expect(result.current.vaultState).toBe('none');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('destroys local vault state when the server reports this device was revoked', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    // Sanity: performChallengeResponse stored the vault marker.
    expect(localStorage.getItem('hush_vault_user_user-1')).not.toBeNull();
    seedAuthOwnedQueryData();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
        detail: { reason: 'device_revoked' },
      }));
    });

    // Server session is gone:
    expectLocalAuthResetState(result.current);
    // Device revoke is intentionally destructive. Keeping the marker
    // would let this browser return to the PIN screen and mint a new
    // session from a revoked local vault.
    expect(localStorage.getItem('hush_vault_user_user-1')).toBeNull();
    expect(vaultMod.deleteVaultDatabase).toHaveBeenCalledWith('user-1');
    expect(transcriptVaultMod.deleteTranscriptDatabase).toHaveBeenCalledWith('user-1');
    expectAuthOwnedQueryDataCleared();
  });

  it('does not downgrade a device_revoked tombstone to server_session_invalid on a later 401', async () => {
    // Reproduces the user-reported bug: device 1 revokes device 2.
    // Device 2's first 401 dispatches `hush_auth_invalid` with reason
    // `device_revoked`, which destroys the local vault and writes the
    // tombstone. A subsequent 401 from an in-flight call (e.g. the
    // post-PIN-unlock challenge-response catch path) used to call
    // `markServerSessionInvalidated('server_session_invalid')` and
    // overwrite the tombstone, leaving stale "recoverable session" state
    // that would let the user return to the PIN screen.
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // First signal: device is revoked. Destructive cleanup runs.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
        detail: { reason: 'device_revoked' },
      }));
    });
    expect(result.current.authInvalidation?.reason).toBe('device_revoked');
    expect(localStorage.getItem('hush_auth_invalidation')).toContain(
      'device_revoked',
    );

    // Second signal: a later in-flight 401 surfaces a generic
    // `server_session_invalid`. The earlier `device_revoked` marker
    // must remain authoritative — revocation is a sticky boundary.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
        detail: { reason: 'server_session_invalid' },
      }));
    });

    expect(result.current.authInvalidation?.reason).toBe('device_revoked');
    expect(localStorage.getItem('hush_auth_invalidation')).toContain(
      'device_revoked',
    );
    expect(localStorage.getItem('hush_auth_invalidation')).not.toContain(
      '"server_session_invalid"',
    );
    expect(result.current.vaultState).toBe('none');
    expect(result.current.hasVault).toBe(false);
  });

  it('preserves the local vault marker for a generic invalid server session', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.performChallengeResponse(
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      );
    });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(localStorage.getItem('hush_vault_user_user-1')).not.toBeNull();
    seedAuthOwnedQueryData();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
        detail: { reason: 'server_session_invalid' },
      }));
    });

    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem('hush_vault_user_user-1')).not.toBeNull();
    expect(result.current.vaultState).toBe('locked');
    expect(result.current.hasVault).toBe(true);
    expect(vaultMod.deleteVaultDatabase).not.toHaveBeenCalledWith('user-1');
    expectAuthOwnedQueryDataCleared();
  });

  it('lands in vaultState=none when no vault marker is present', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
        detail: { reason: 'device_revoked' },
      }));
    });

    expectLocalAuthResetState(result.current);
  });
});
