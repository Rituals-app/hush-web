/**
 * Tests for useMLS hook contract.
 *
 * Verifies:
 * - encryptForChannel delegates to mlsGroup.encryptMessage
 * - encryptForChannel throws when channelId is missing (no silent fallback)
 * - encryptForChannel does NOT wrap errors in plaintext envelope
 * - decryptFromChannel delegates to mlsGroup.decryptMessage
 * - decryptFromChannel throws on non-application messages
 * - getCachedMessage returns cached plaintext from mlsStore
 * - setCachedMessage persists plaintext to mlsStore
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMLS } from './useMLS';
import { setTranscriptCache, clearTranscriptCache } from '../lib/transcriptVault';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockDb() {
  return { transaction: vi.fn(), objectStoreNames: { contains: vi.fn() } };
}

function makeMockDeps() {
  return {
    mlsGroup: {
      encryptMessage: vi.fn().mockResolvedValue({
        messageBytes: new Uint8Array([1, 2, 3]),
        localId: 'mock-local-id',
      }),
      catchupCommits: vi.fn().mockResolvedValue(undefined),
      decryptMessage: vi.fn().mockResolvedValue({
        plaintext: 'decrypted-hello',
        type: 'application',
        epoch: 1,
        senderIdentity: 'sender-123',
      }),
      exportGuildMetadataKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    },
    mlsStore: {
      getCredential: vi.fn().mockResolvedValue({
        signingPublicKey: new Uint8Array([10]),
        signingPrivateKey: new Uint8Array([20]),
        credentialBytes: new Uint8Array([30]),
      }),
      getLocalPlaintext: vi.fn().mockResolvedValue(null),
      setLocalPlaintext: vi.fn().mockResolvedValue(undefined),
    },
    hushCrypto: {},
    api: {},
  };
}

function makeGetStore(db) {
  return vi.fn().mockResolvedValue(db);
}

function makeGetToken() {
  return vi.fn().mockReturnValue('mock-jwt-token');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMLS', () => {
  let mockDb;
  let mockDeps;
  let getStore;
  let getToken;

  beforeEach(() => {
    mockDb = makeMockDb();
    mockDeps = makeMockDeps();
    getStore = makeGetStore(mockDb);
    getToken = makeGetToken();
  });

  describe('encryptForChannel', () => {
    it('delegates to mlsGroup.encryptMessage with correct channelId and returns ciphertext', async () => {
      const channelId = 'channel-abc';
      const { encryptForChannel } = useMLS({
        getStore,
        getToken,
        channelId,
        _deps: mockDeps,
      });

      const result = await encryptForChannel('hello world');

      expect(mockDeps.mlsGroup.encryptMessage).toHaveBeenCalledTimes(1);
      const [deps, passedChannelId, plaintext] = mockDeps.mlsGroup.encryptMessage.mock.calls[0];
      expect(passedChannelId).toBe('channel-abc');
      expect(plaintext).toBe('hello world');
      expect(result.ciphertext).toBeInstanceOf(Uint8Array);
      expect(Array.from(result.ciphertext)).toEqual([1, 2, 3]);
      expect(result.localId).toBe('mock-local-id');
    });

    it('throws when channelId is not set', async () => {
      const { encryptForChannel } = useMLS({
        getStore,
        getToken,
        channelId: undefined,
        _deps: mockDeps,
      });

      await expect(encryptForChannel('hello')).rejects.toThrow(
        'channelId is required for encryptForChannel'
      );
    });

    it('does NOT wrap errors in a plaintext envelope (_hush_plaintext)', async () => {
      mockDeps.mlsGroup.encryptMessage.mockRejectedValue(new Error('MLS encrypt failed'));

      const { encryptForChannel } = useMLS({
        getStore,
        getToken,
        channelId: 'channel-xyz',
        _deps: mockDeps,
      });

      // The error must propagate - not be caught and wrapped in a plaintext fallback
      await expect(encryptForChannel('test')).rejects.toThrow('MLS encrypt failed');
    });

    it('result never contains _hush_plaintext field', async () => {
      const { encryptForChannel } = useMLS({
        getStore,
        getToken,
        channelId: 'channel-test',
        _deps: mockDeps,
      });

      const result = await encryptForChannel('some text');

      // Verify no plaintext fallback envelope exists in the result
      expect(result).not.toHaveProperty('_hush_plaintext');
      expect(result).not.toHaveProperty('plaintext');
      expect(JSON.stringify(result)).not.toContain('_hush_plaintext');
    });
  });

  describe('decryptFromChannel', () => {
    it('delegates to mlsGroup.decryptMessage and returns plaintext string', async () => {
      const channelId = 'channel-decrypt';
      const { decryptFromChannel } = useMLS({
        getStore,
        getToken,
        channelId,
        _deps: mockDeps,
      });

      const messageBytes = new Uint8Array([10, 20, 30]);
      const result = await decryptFromChannel(messageBytes);

      expect(mockDeps.mlsGroup.decryptMessage).toHaveBeenCalledTimes(1);
      const [deps, passedChannelId, passedBytes] = mockDeps.mlsGroup.decryptMessage.mock.calls[0];
      expect(passedChannelId).toBe('channel-decrypt');
      expect(passedBytes).toBe(messageBytes);
      expect(result).toBe('decrypted-hello');
    });

    it('retries decrypt after catchup before failing', async () => {
      mockDeps.mlsGroup.decryptMessage
        .mockRejectedValueOnce(new Error('group.process_message failed: ValidationError(UnableToDecrypt(AeadError))'))
        .mockResolvedValueOnce({
          plaintext: 'after-catchup',
          type: 'application',
          epoch: 2,
          senderIdentity: 'sender-123',
        });

      const { decryptFromChannel } = useMLS({
        getStore,
        getToken,
        channelId: 'channel-decrypt',
        _deps: mockDeps,
      });

      const result = await decryptFromChannel(new Uint8Array([10, 20, 30]));

      expect(mockDeps.mlsGroup.catchupCommits).toHaveBeenCalledTimes(1);
      expect(mockDeps.mlsGroup.catchupCommits).toHaveBeenCalledWith(
        expect.objectContaining({ db: mockDb, token: 'mock-jwt-token' }),
        'channel-decrypt',
      );
      expect(mockDeps.mlsGroup.decryptMessage).toHaveBeenCalledTimes(2);
      expect(result).toBe('after-catchup');
    });

    it('threads baseUrl into the catchup deps so the JWT is not leaked to window.location.origin', async () => {
      // Regression: PR #13 / instance JWT leakage in MLS catch-up.
      // The catch-up retry path was previously calling
      // `api.getMLSCommitsSinceEpoch` without a baseUrl, sending the
      // per-instance Bearer token to the current origin. The hook must
      // now forward the owning instance URL through deps so the request
      // hits the issuing instance.
      mockDeps.mlsGroup.decryptMessage
        .mockRejectedValueOnce(new Error('AeadError'))
        .mockResolvedValueOnce({
          plaintext: 'recovered',
          type: 'application',
          epoch: 2,
          senderIdentity: 'sender-123',
        });

      const { decryptFromChannel } = useMLS({
        getStore,
        getToken,
        channelId: 'channel-decrypt',
        baseUrl: 'https://chat.example.com',
        _deps: mockDeps,
      });

      await decryptFromChannel(new Uint8Array([10, 20, 30]));

      expect(mockDeps.mlsGroup.catchupCommits).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://chat.example.com' }),
        'channel-decrypt',
      );
    });

    it('forwards an empty baseUrl by default so same-origin callers stay backward-compatible', async () => {
      mockDeps.mlsGroup.decryptMessage
        .mockRejectedValueOnce(new Error('AeadError'))
        .mockResolvedValueOnce({
          plaintext: 'recovered',
          type: 'application',
          epoch: 2,
          senderIdentity: 'sender-123',
        });

      const { decryptFromChannel } = useMLS({
        getStore,
        getToken,
        channelId: 'channel-decrypt',
        _deps: mockDeps,
      });

      await decryptFromChannel(new Uint8Array([10, 20, 30]));

      expect(mockDeps.mlsGroup.catchupCommits).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: '' }),
        'channel-decrypt',
      );
    });

    it('rethrows the primary decrypt error when catchup and retry do not recover', async () => {
      const primaryError = new Error('group.process_message failed: ValidationError(UnableToDecrypt(AeadError))');
      mockDeps.mlsGroup.decryptMessage
        .mockRejectedValueOnce(primaryError)
        .mockRejectedValueOnce(new Error('retry failed'));
      mockDeps.mlsGroup.catchupCommits.mockRejectedValueOnce(new Error('catchup failed'));

      const getHistoryStore = vi.fn().mockResolvedValue(makeMockDb());

      const { decryptFromChannel } = useMLS({
        getStore,
        getHistoryStore,
        getToken,
        channelId: 'channel-decrypt',
        _deps: mockDeps,
      });

      await expect(decryptFromChannel(new Uint8Array([10, 20, 30]))).rejects.toThrow(primaryError.message);
      expect(getHistoryStore).not.toHaveBeenCalled();
    });

    it('throws on non-application messages (plaintext is null)', async () => {
      mockDeps.mlsGroup.decryptMessage.mockResolvedValue({
        plaintext: null,
        type: 'commit',
        epoch: 2,
      });

      const { decryptFromChannel } = useMLS({
        getStore,
        getToken,
        channelId: 'channel-commit',
        _deps: mockDeps,
      });

      await expect(decryptFromChannel(new Uint8Array([1]))).rejects.toThrow(
        'non-application message'
      );
    });

    it('throws when channelId is not set', async () => {
      const { decryptFromChannel } = useMLS({
        getStore,
        getToken,
        channelId: undefined,
        _deps: mockDeps,
      });

      await expect(decryptFromChannel(new Uint8Array([1]))).rejects.toThrow(
        'channelId is required for decryptFromChannel'
      );
    });
  });

  describe('getCachedMessage', () => {
    it('returns cached plaintext from mlsStore', async () => {
      mockDeps.mlsStore.getLocalPlaintext.mockResolvedValue({
        plaintext: 'cached hello',
        timestamp: 1700000000,
      });

      const { getCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      const result = await getCachedMessage('msg-123');

      expect(mockDeps.mlsStore.getLocalPlaintext).toHaveBeenCalledWith(mockDb, 'msg-123');
      expect(result).toEqual({ content: 'cached hello', timestamp: 1700000000 });
    });

    it('returns null when no cached message exists', async () => {
      mockDeps.mlsStore.getLocalPlaintext.mockResolvedValue(null);

      const { getCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      const result = await getCachedMessage('msg-nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when store is unavailable', async () => {
      getStore = vi.fn().mockResolvedValue(null);

      const { getCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      const result = await getCachedMessage('msg-123');
      expect(result).toBeNull();
    });

    it('surfaces senderId when present (link-time pre-decrypt entries)', async () => {
      mockDeps.mlsStore.getLocalPlaintext.mockResolvedValue({
        plaintext: 'old peer message',
        timestamp: 1700000000,
        senderId: 'peer-uuid',
      });

      const { getCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      const result = await getCachedMessage('msg-pre-decrypted');
      expect(result).toEqual({
        content: 'old peer message',
        timestamp: 1700000000,
        senderId: 'peer-uuid',
      });
    });

    it('omits senderId when the cached row has none (legacy self-send entries)', async () => {
      mockDeps.mlsStore.getLocalPlaintext.mockResolvedValue({
        plaintext: 'own send',
        timestamp: 1700000000,
      });

      const { getCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      const result = await getCachedMessage('msg-own');
      expect(result).toEqual({ content: 'own send', timestamp: 1700000000 });
      expect(result.senderId).toBeUndefined();
    });

    it('back-fills the channel tag on an untagged row', async () => {
      mockDeps.mlsStore.getLocalPlaintext.mockResolvedValue({ plaintext: 'p', timestamp: 1 });
      mockDeps.mlsStore.tagLocalPlaintext = vi.fn().mockResolvedValue(undefined);
      const { getCachedMessage } = useMLS({ getStore, getToken, channelId: 'ch-1', _deps: mockDeps });
      expect(await getCachedMessage('msg-legacy')).toEqual({ content: 'p', timestamp: 1 });
      expect(mockDeps.mlsStore.tagLocalPlaintext).toHaveBeenCalledWith(mockDb, 'msg-legacy', 'ch-1');
    });

    it('tags a transcript-vault hit so a removal can forget it', async () => {
      mockDeps.mlsStore.getLocalPlaintext.mockResolvedValue(null);
      mockDeps.mlsStore.tagLocalPlaintext = vi.fn().mockResolvedValue(undefined);
      setTranscriptCache('u-1', [{ messageId: 'msg-vault', plaintext: 'v', timestamp: 2 }]);
      try {
        const { getCachedMessage } = useMLS({ getStore, getToken, channelId: 'ch-1', _deps: mockDeps });
        expect(await getCachedMessage('msg-vault')).toEqual({ content: 'v', timestamp: 2 });
        expect(mockDeps.mlsStore.tagLocalPlaintext).toHaveBeenCalledWith(mockDb, 'msg-vault', 'ch-1');
      } finally {
        clearTranscriptCache();
      }
    });
  });

  describe('ensureChannelGroup', () => {
    it('drops the channel group and plaintext when the server refuses with 403', async () => {
      mockDeps.mlsStore.getGroupEpoch = vi.fn().mockResolvedValue(null);
      mockDeps.mlsGroup.joinOrCreateChannelGroup = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
      mockDeps.mlsGroup.leaveAllChannelGroups = vi.fn().mockResolvedValue(undefined);
      const { ensureChannelGroup } = useMLS({ getStore, getToken, channelId: 'ch-1', _deps: mockDeps });
      await ensureChannelGroup();
      expect(mockDeps.mlsGroup.leaveAllChannelGroups).toHaveBeenCalledWith(expect.any(Object), ['ch-1']);
    });

    it('keeps local state on other failures', async () => {
      mockDeps.mlsStore.getGroupEpoch = vi.fn().mockResolvedValue(null);
      mockDeps.mlsGroup.joinOrCreateChannelGroup = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
      mockDeps.mlsGroup.leaveAllChannelGroups = vi.fn().mockResolvedValue(undefined);
      const { ensureChannelGroup } = useMLS({ getStore, getToken, channelId: 'ch-1', _deps: mockDeps });
      await ensureChannelGroup();
      expect(mockDeps.mlsGroup.leaveAllChannelGroups).not.toHaveBeenCalled();
    });
  });

  describe('setCachedMessage', () => {
    it('persists plaintext to mlsStore', async () => {
      const { setCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      await setCachedMessage('msg-456', {
        content: 'hello world',
        timestamp: 1700000001,
      });

      expect(mockDeps.mlsStore.setLocalPlaintext).toHaveBeenCalledWith(mockDb, 'msg-456', {
        plaintext: 'hello world',
        timestamp: 1700000001,
        channelId: 'ch-1',
      });
    });

    it('does not throw when store is unavailable', async () => {
      getStore = vi.fn().mockResolvedValue(null);

      const { setCachedMessage } = useMLS({
        getStore,
        getToken,
        channelId: 'ch-1',
        _deps: mockDeps,
      });

      // Should not throw - silent failure for cache operations
      await expect(
        setCachedMessage('msg-789', { content: 'test', timestamp: 0 })
      ).resolves.toBeUndefined();
    });
  });
});
