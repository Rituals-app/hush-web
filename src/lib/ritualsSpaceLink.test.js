import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RITUALS_SPACE_ORIGINS,
  consumeDeviceJustLinked,
  hasEarlierMessagesElsewhere,
  isDeviceLinkAccountMismatch,
  isSameLinkInstance,
  joinLinkedDeviceChannels,
  markDeviceJustLinked,
  markEarlierMessagesElsewhere,
  readSpaceAccount,
  shouldOfferDeviceLink,
  writeSpaceAccount,
} from './ritualsSpaceLink.js';
import { SPACE_ACCOUNT_KEY } from './ritualsSpace.js';

const ACCT_A = 'a'.repeat(64);
const ACCT_B = 'b'.repeat(64);

beforeEach(() => {
  window.localStorage.clear();
});

describe('isSameLinkInstance', () => {
  it('treats the two Rituals Space origins as one instance, both ways', () => {
    expect(RITUALS_SPACE_ORIGINS).toEqual(['https://space.rit.al', 'https://space.rituals.app']);
    expect(isSameLinkInstance('https://space.rit.al', 'https://space.rituals.app')).toBe(true);
    expect(isSameLinkInstance('https://space.rituals.app/', 'https://space.rit.al')).toBe(true);
  });

  it('keeps equal origins equal', () => {
    expect(isSameLinkInstance('https://chat.example.com', 'https://chat.example.com/')).toBe(true);
  });

  it('does not weaken the check for any other pair', () => {
    expect(isSameLinkInstance('https://space.rit.al', 'https://evil.example')).toBe(false);
    expect(isSameLinkInstance('https://evil.example', 'https://space.rituals.app')).toBe(false);
    expect(isSameLinkInstance('https://space.rit.al', 'http://space.rituals.app')).toBe(false);
    expect(isSameLinkInstance('https://space.rit.al', 'https://space.rit.al.evil.example')).toBe(false);
    expect(isSameLinkInstance('https://a.example', 'https://b.example')).toBe(false);
  });

  it('never matches unparsable or empty values', () => {
    expect(isSameLinkInstance('', '')).toBe(false);
    expect(isSameLinkInstance(null, 'https://space.rit.al')).toBe(false);
    expect(isSameLinkInstance('not a url', 'not a url')).toBe(false);
  });
});

describe('account marker', () => {
  it('reads and writes only well-formed markers', () => {
    expect(readSpaceAccount()).toBeNull();
    expect(writeSpaceAccount('xyz')).toBe(false);
    expect(readSpaceAccount()).toBeNull();
    expect(writeSpaceAccount(ACCT_A)).toBe(true);
    expect(window.localStorage.getItem(SPACE_ACCOUNT_KEY)).toBe(ACCT_A);
    expect(readSpaceAccount()).toBe(ACCT_A);
    window.localStorage.setItem(SPACE_ACCOUNT_KEY, 'tampered');
    expect(readSpaceAccount()).toBeNull();
  });

  it('refuses a link only when both markers exist and differ', () => {
    expect(isDeviceLinkAccountMismatch(ACCT_A, ACCT_B)).toBe(true);
    expect(isDeviceLinkAccountMismatch(ACCT_A, ACCT_A)).toBe(false);
    expect(isDeviceLinkAccountMismatch(null, ACCT_B)).toBe(false);
    expect(isDeviceLinkAccountMismatch(ACCT_A, null)).toBe(false);
  });
});

describe('shouldOfferDeviceLink', () => {
  it('is feature-detected on the ticket hint seated === true', () => {
    expect(shouldOfferDeviceLink({ hasIdentity: false, hints: { seated: true } })).toBe(true);
    expect(shouldOfferDeviceLink({ hasIdentity: false, hints: { seated: false } })).toBe(false);
    expect(shouldOfferDeviceLink({ hasIdentity: false, hints: {} })).toBe(false);
    expect(shouldOfferDeviceLink({ hasIdentity: false, hints: null })).toBe(false);
    expect(shouldOfferDeviceLink({ hasIdentity: true, hints: { seated: true } })).toBe(false);
  });
});

describe('link markers', () => {
  it('just-linked is consumed once', () => {
    expect(consumeDeviceJustLinked()).toBe(false);
    markDeviceJustLinked();
    expect(consumeDeviceJustLinked()).toBe(true);
    expect(consumeDeviceJustLinked()).toBe(false);
  });

  it('earlier-elsewhere is per space', () => {
    expect(hasEarlierMessagesElsewhere('s1')).toBe(false);
    markEarlierMessagesElsewhere('s1');
    markEarlierMessagesElsewhere('s1');
    expect(hasEarlierMessagesElsewhere('s1')).toBe(true);
    expect(hasEarlierMessagesElsewhere('s2')).toBe(false);
    expect(JSON.parse(window.localStorage.getItem('rituals_space_earlier_elsewhere'))).toEqual(['s1']);
  });
});

function fakeDeps({ credential = { signingPrivateKey: new Uint8Array(1) }, epochs = {}, channels = {} } = {}) {
  const db = { name: 'fake' };
  return {
    db,
    mlsGroup: { joinAllChannelGroups: vi.fn(async () => {}) },
    mlsStore: {
      openStore: vi.fn(async () => db),
      getCredential: vi.fn(async () => credential),
      getGroupEpoch: vi.fn(async (_db, id) => (id in epochs ? epochs[id] : null)),
    },
    hushCrypto: {},
    api: {
      getGuildChannels: vi.fn(async (_token, serverId) => {
        if (channels[serverId] instanceof Error) throw channels[serverId];
        return channels[serverId] ?? [];
      }),
    },
  };
}

describe('joinLinkedDeviceChannels', () => {
  const base = { userId: 'u1', deviceId: 'd1', token: 't', baseUrl: 'https://space.rit.al' };

  it('does nothing without this device credential', async () => {
    const deps = fakeDeps({ credential: null });
    const out = await joinLinkedDeviceChannels({ ...base, serverIds: ['s1'], _deps: deps });
    expect(out).toEqual({ joined: 0, skipped: 0, reason: 'no_credential' });
    expect(deps.mlsGroup.joinAllChannelGroups).not.toHaveBeenCalled();
  });

  it('does nothing without spaces', async () => {
    const deps = fakeDeps();
    const out = await joinLinkedDeviceChannels({ ...base, serverIds: [], _deps: deps });
    expect(out.reason).toBe('nothing_to_join');
    expect(deps.mlsStore.openStore).not.toHaveBeenCalled();
  });

  it('joins text channels without a local epoch, skips the rest', async () => {
    const deps = fakeDeps({
      epochs: { c2: 4 },
      channels: {
        s1: [
          { id: 'c1', type: 'text' },
          { id: 'c2', type: 'text' },
          { id: 'v1', type: 'voice' },
          { id: 'k1', type: 'category' },
        ],
        s2: new Error('offline'),
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await joinLinkedDeviceChannels({ ...base, serverIds: ['s1', 's2'], _deps: deps });
    warn.mockRestore();
    expect(out).toEqual({ joined: 1, skipped: 1 });
    expect(deps.mlsGroup.joinAllChannelGroups).toHaveBeenCalledTimes(1);
    const [passedDeps, ids] = deps.mlsGroup.joinAllChannelGroups.mock.calls[0];
    expect(ids).toEqual(['c1']);
    expect(passedDeps).toMatchObject({ db: deps.db, token: 't', baseUrl: 'https://space.rit.al' });
    expect(passedDeps.credential).toBeTruthy();
    expect(deps.mlsStore.openStore).toHaveBeenCalledWith('u1', 'd1');
  });
});
