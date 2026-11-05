/**
 * Tests for preDecryptForLinkExport — the OLD-device link-export pre-decrypt.
 *
 * Run entirely against injected dependency stubs; no real WASM, no real IDB.
 */

import { describe, it, expect, vi } from 'vitest';
import { preDecryptForLinkExport } from './preDecryptForLinkExport';

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function makeMessage(id, senderId, plaintext, isoTs) {
  return {
    id,
    senderId,
    timestamp: isoTs,
    ciphertext: bytesToBase64(new TextEncoder().encode(`ct:${id}`)),
    _plaintext: plaintext,
  };
}

function makeStubs({
  guilds = [],
  channelsByGuild = {},
  messagesByChannel = {},
  failOnGuildList = false,
  failOnChannel = null,
  decryptOverride = null,
  catchupRecover = false,
} = {}) {
  const localPlaintextStore = new Map();
  const activeDb = { id: 'active' };

  const mlsStore = {
    getCredential: vi.fn().mockResolvedValue({
      signingPrivateKey: new Uint8Array([1]),
      signingPublicKey: new Uint8Array([2]),
      credentialBytes: new Uint8Array([3]),
    }),
    getLocalPlaintext: vi.fn(async (_db, id) => localPlaintextStore.get(id) ?? null),
    setLocalPlaintext: vi.fn(async (_db, id, payload) => {
      localPlaintextStore.set(id, { ...payload });
    }),
  };

  const lookup = (ct) => {
    const text = new TextDecoder().decode(ct);
    const id = text.startsWith('ct:') ? text.slice(3) : null;
    return id
      ? Object.values(messagesByChannel).flat().find((m) => m.id === id)
      : null;
  };

  let primaryFailures = new Set();
  const mlsGroup = {
    decryptMessage: vi.fn(async (_deps, _channelId, ct) => {
      if (decryptOverride) return decryptOverride(ct);
      const id = lookup(ct)?.id;
      if (catchupRecover && id && !primaryFailures.has(id)) {
        primaryFailures.add(id);
        throw new Error('transient');
      }
      const msg = lookup(ct);
      if (!msg) throw new Error('Group not found');
      return { plaintext: msg._plaintext, type: 'application', epoch: 1 };
    }),
    catchupCommits: vi.fn().mockResolvedValue(undefined),
  };

  const hushCrypto = {};

  const api = {
    getMyGuilds: vi.fn(async () => {
      if (failOnGuildList) throw new Error('network down');
      return guilds;
    }),
    getGuildChannels: vi.fn(async (_token, guildId) => channelsByGuild[guildId] ?? []),
    getChannelMessages: vi.fn(async (_token, _serverId, channelId) => {
      if (failOnChannel === channelId) throw new Error('channel fetch fail');
      return messagesByChannel[channelId] ?? [];
    }),
  };

  return { mlsGroup, mlsStore, hushCrypto, api, localPlaintextStore, activeDb };
}

describe('preDecryptForLinkExport', () => {
  it('returns an empty summary when activeDb or token is missing', async () => {
    const stubs = makeStubs();
    const a = await preDecryptForLinkExport({ activeDb: null, token: 't', _deps: stubs });
    const b = await preDecryptForLinkExport({ activeDb: stubs.activeDb, token: '', _deps: stubs });
    expect(a).toEqual({ channels: 0, processed: 0, decrypted: 0, failed: 0, skipped: 0 });
    expect(b).toEqual({ channels: 0, processed: 0, decrypted: 0, failed: 0, skipped: 0 });
    expect(stubs.api.getMyGuilds).not.toHaveBeenCalled();
  });

  it('returns an empty summary when the active store has no credential', async () => {
    const stubs = makeStubs();
    stubs.mlsStore.getCredential = vi.fn().mockResolvedValue(null);
    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });
    expect(summary).toEqual({ channels: 0, processed: 0, decrypted: 0, failed: 0, skipped: 0 });
    expect(stubs.api.getMyGuilds).not.toHaveBeenCalled();
  });

  it('decrypts every text channel message via the active path and writes plaintext + senderId', async () => {
    const messages = [
      makeMessage('m1', 'alice', 'hi alice', '2026-04-01T10:00:00Z'),
      makeMessage('m2', 'bob',   'hi bob',   '2026-04-01T11:00:00Z'),
    ];
    const stubs = makeStubs({
      guilds: [{ id: 'g1' }],
      channelsByGuild: {
        g1: [
          { id: 'text', type: 'text' },
          { id: 'voice', type: 'voice' },
        ],
      },
      messagesByChannel: { text: messages },
    });

    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });

    expect(summary.channels).toBe(1);
    expect(summary.processed).toBe(2);
    expect(summary.decrypted).toBe(2);
    expect(summary.failed).toBe(0);

    expect(stubs.localPlaintextStore.get('m1')).toEqual({
      plaintext: 'hi alice',
      senderId: 'alice',
      timestamp: new Date('2026-04-01T10:00:00Z').getTime(),
      channelId: 'text',
    });
    expect(stubs.localPlaintextStore.get('m2')).toEqual({
      plaintext: 'hi bob',
      senderId: 'bob',
      timestamp: new Date('2026-04-01T11:00:00Z').getTime(),
      channelId: 'text',
    });
    // voice channel skipped
    expect(stubs.api.getChannelMessages).toHaveBeenCalledTimes(1);
    expect(stubs.api.getChannelMessages.mock.calls[0][2]).toBe('text');
  });

  it('feeds messages chronologically regardless of API return order', async () => {
    const newer = makeMessage('newer', 'alice', 'newer', '2026-04-02T00:00:00Z');
    const older = makeMessage('older', 'alice', 'older', '2026-04-01T00:00:00Z');
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: { g: [{ id: 'c', type: 'text' }] },
      messagesByChannel: { c: [newer, older] },
    });

    await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });

    const order = stubs.mlsGroup.decryptMessage.mock.calls.map(
      (args) => new TextDecoder().decode(args[2]),
    );
    expect(order).toEqual(['ct:older', 'ct:newer']);
  });

  it('skips messages already cached', async () => {
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: { g: [{ id: 'c', type: 'text' }] },
      messagesByChannel: {
        c: [makeMessage('mPre', 'alice', 'first', '2026-04-01T00:00:00Z')],
      },
    });
    stubs.localPlaintextStore.set('mPre', { plaintext: 'cached', timestamp: 1 });

    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });

    expect(summary.processed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.decrypted).toBe(0);
    expect(summary.failed).toBe(0);
    expect(stubs.localPlaintextStore.get('mPre').plaintext).toBe('cached');
    expect(stubs.mlsGroup.decryptMessage).not.toHaveBeenCalled();
  });

  it('retries via catchupCommits before counting a failure', async () => {
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: { g: [{ id: 'c', type: 'text' }] },
      messagesByChannel: {
        c: [makeMessage('mRetry', 'alice', 'eventually OK', '2026-04-01T00:00:00Z')],
      },
      catchupRecover: true,
    });

    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });

    expect(summary.decrypted).toBe(1);
    expect(summary.failed).toBe(0);
    expect(stubs.mlsGroup.catchupCommits).toHaveBeenCalledTimes(1);
    expect(stubs.localPlaintextStore.get('mRetry').plaintext).toBe('eventually OK');
  });

  it('forwards the trusted baseUrl into the catchup deps (PR #13 JWT leak regression)', async () => {
    // Regression for the per-instance JWT leak class: the link-export
    // pre-decrypt path runs a catchup retry on transient decrypt
    // failures. The catchup must hit the owning instance URL passed
    // into preDecryptForLinkExport and never silently fall back to
    // window.location.origin (which would leak the per-instance JWT
    // to the host that served the SPA).
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: { g: [{ id: 'c', type: 'text' }] },
      messagesByChannel: {
        c: [makeMessage('mRetry', 'alice', 'eventually OK', '2026-04-01T00:00:00Z')],
      },
      catchupRecover: true,
    });

    await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      baseUrl: 'https://chat.example.com',
      _deps: stubs,
    });

    expect(stubs.mlsGroup.catchupCommits).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://chat.example.com' }),
      'c',
    );
  });

  it('counts a failure when both decrypt and catchup retry fail (TooDistantInThePast)', async () => {
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: { g: [{ id: 'c', type: 'text' }] },
      messagesByChannel: {
        c: [makeMessage('mFail', 'alice', 'lost', '2026-04-01T00:00:00Z')],
      },
      decryptOverride: () => { throw new Error('TooDistantInThePast'); },
    });

    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });

    expect(summary.processed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.decrypted).toBe(0);
    expect(stubs.localPlaintextStore.get('mFail')).toBeUndefined();
  });

  it('continues across channels when one channel fetch fails', async () => {
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: {
        g: [
          { id: 'broken', type: 'text' },
          { id: 'ok', type: 'text' },
        ],
      },
      messagesByChannel: {
        ok: [makeMessage('m1', 'alice', 'hi', '2026-04-01T00:00:00Z')],
      },
      failOnChannel: 'broken',
    });

    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });

    expect(summary.channels).toBe(2);
    expect(summary.decrypted).toBe(1);
    expect(stubs.localPlaintextStore.get('m1')).toBeDefined();
  });

  it('returns an empty summary when the guild list call fails', async () => {
    const stubs = makeStubs({ failOnGuildList: true });
    const summary = await preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    });
    expect(summary).toEqual({ channels: 0, processed: 0, decrypted: 0, failed: 0, skipped: 0 });
    expect(stubs.api.getGuildChannels).not.toHaveBeenCalled();
    expect(stubs.mlsGroup.decryptMessage).not.toHaveBeenCalled();
  });

  it('does not throw when an unexpected channel-level exception bubbles', async () => {
    const stubs = makeStubs({
      guilds: [{ id: 'g' }],
      channelsByGuild: { g: [{ id: 'c', type: 'text' }] },
      messagesByChannel: {
        c: [makeMessage('m1', 'alice', 'hi', '2026-04-01T00:00:00Z')],
      },
    });
    // Simulate a totally unexpected throw from decryptMessage that isn't caught
    // by decryptOnce (decryptOnce already swallows; double-wrap to ensure outer
    // resilience by making setLocalPlaintext throw).
    stubs.mlsStore.setLocalPlaintext = vi.fn().mockRejectedValue(new Error('IDB blew up'));
    await expect(preDecryptForLinkExport({
      activeDb: stubs.activeDb,
      token: 't',
      _deps: stubs,
    })).resolves.toBeDefined();
  });
});
