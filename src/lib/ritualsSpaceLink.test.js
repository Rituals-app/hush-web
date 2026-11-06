import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RITUALS_SPACE_ORIGINS,
  consumeDeviceJustLinked,
  earlierMessagesElsewhereBefore,
  isDeviceLinkAccountMismatch,
  isRitualsSpaceOrigin,
  isSameLinkInstance,
  isSpaceDeviceLink,
  joinLinkedDeviceChannels,
  markDeviceJustLinked,
  markEarlierMessagesElsewhere,
  readSpaceAccount,
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

  it('refuses a link when both markers exist and differ', () => {
    expect(isDeviceLinkAccountMismatch(ACCT_A, ACCT_B)).toBe(true);
    expect(isDeviceLinkAccountMismatch(ACCT_A, ACCT_A)).toBe(false);
    expect(isDeviceLinkAccountMismatch(null, ACCT_B)).toBe(false);
    expect(isDeviceLinkAccountMismatch(ACCT_A, null)).toBe(false);
  });

  it('fails closed on an omitted acct when the bundle acct is required', () => {
    expect(isDeviceLinkAccountMismatch(null, ACCT_B, { requireBundleAcct: true })).toBe(true);
    expect(isDeviceLinkAccountMismatch(undefined, ACCT_B, { requireBundleAcct: true })).toBe(true);
    expect(isDeviceLinkAccountMismatch(ACCT_B, ACCT_B, { requireBundleAcct: true })).toBe(false);
    // A device with no marker yet is not bound to any account.
    expect(isDeviceLinkAccountMismatch(null, null, { requireBundleAcct: true })).toBe(false);
  });

  it('is a Space link only on a Rituals origin with matching markers', () => {
    expect(isSpaceDeviceLink({ bundleAcct: ACCT_A, localAcct: ACCT_A, onRitualsOrigin: true })).toBe(true);
    expect(isSpaceDeviceLink({ bundleAcct: ACCT_A, localAcct: ACCT_A, onRitualsOrigin: false })).toBe(false);
    expect(isSpaceDeviceLink({ bundleAcct: ACCT_A, localAcct: null, onRitualsOrigin: true })).toBe(false);
    expect(isSpaceDeviceLink({ bundleAcct: null, localAcct: ACCT_A, onRitualsOrigin: true })).toBe(false);
    expect(isSpaceDeviceLink({ bundleAcct: ACCT_A, localAcct: ACCT_B, onRitualsOrigin: true })).toBe(false);
  });

  it('recognises only the two Rituals Space origins', () => {
    expect(isRitualsSpaceOrigin('https://space.rit.al')).toBe(true);
    expect(isRitualsSpaceOrigin('https://space.rituals.app/')).toBe(true);
    expect(isRitualsSpaceOrigin('https://space.rit.al.evil.example')).toBe(false);
    expect(isRitualsSpaceOrigin('http://space.rit.al')).toBe(false);
    expect(isRitualsSpaceOrigin(null)).toBe(false);
  });
});

describe('link markers', () => {
  it('just-linked is consumed once and carries the link time', () => {
    expect(consumeDeviceJustLinked()).toBeNull();
    markDeviceJustLinked(1_700_000_000_000);
    expect(consumeDeviceJustLinked()).toBe(1_700_000_000_000);
    expect(consumeDeviceJustLinked()).toBeNull();
  });

  it('earlier-elsewhere is per space and bounded by the link time', () => {
    expect(earlierMessagesElsewhereBefore('s1')).toBeNull();
    markEarlierMessagesElsewhere('s1', 1000);
    markEarlierMessagesElsewhere('s1', 2000);
    expect(earlierMessagesElsewhereBefore('s1')).toBe(2000);
    expect(earlierMessagesElsewhereBefore('s2')).toBeNull();
    markEarlierMessagesElsewhere('s3');
    expect(earlierMessagesElsewhereBefore('s3')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('rituals_space_earlier_elsewhere'))).toEqual([{ id: 's1', at: 2000 }]);
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
