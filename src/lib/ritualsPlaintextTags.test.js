import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  openStore,
  setLocalPlaintext,
  getLocalPlaintextTagState,
  deleteLocalPlaintextsForChannels,
  getLocalPlaintext,
  listAllLocalPlaintexts,
  tagLocalPlaintext,
} from './mlsStore';
import { sweepLegacyPlaintextTags } from './ritualsPlaintextTags';

let n = 0;
const nextDb = () => openStore(`sweep-user-${++n}-${Date.now()}`, 'dev');

const msg = (id, ts) => ({ id, channelId: 'x', senderId: 's', ciphertext: 'c', timestamp: new Date(ts).toISOString() });

describe('sweepLegacyPlaintextTags', () => {
  it('tags legacy rows (and untagged vault entries) with the channel they are found in, so a removal deletes them', async () => {
    const db = await nextDb();
    await setLocalPlaintext(db, 'old-a', { plaintext: 'a', timestamp: 1 });
    await setLocalPlaintext(db, 'old-b', { plaintext: 'b', timestamp: 2 });
    await setLocalPlaintext(db, 'elsewhere', { plaintext: 'z', timestamp: 3 });
    const pages = {
      'ch-1': [[msg('new-1', 5000), msg('old-a', 4000)]],
      'ch-2': [[msg('old-b', 3000)]],
    };
    const fetchMessages = vi.fn(async (_t, _s, channelId) => pages[channelId].shift() ?? []);
    const tagged = await sweepLegacyPlaintextTags({
      db,
      token: 't',
      serverId: 's',
      channelIds: ['ch-1', 'ch-2'],
      fetchMessages,
      transcriptRows: () => [{ messageId: 'new-1', plaintext: 'vault' }],
    });
    expect(tagged).toBe(3);
    const state = await getLocalPlaintextTagState(db);
    expect([...state.untagged]).toEqual(['elsewhere']);
    expect([...state.swept].sort()).toEqual(['ch-1', 'ch-2']);
    expect((await deleteLocalPlaintextsForChannels(db, ['ch-1'])).sort()).toEqual(['new-1', 'old-a']);
    expect(await getLocalPlaintext(db, 'old-b')).toMatchObject({ plaintext: 'b', channelId: 'ch-2' });
    db.close();
  });

  it('makes no request when nothing is untagged, and skips a refused channel without marking it', async () => {
    const db = await nextDb();
    const fetchMessages = vi.fn();
    expect(await sweepLegacyPlaintextTags({ db, token: 't', serverId: 's', channelIds: ['ch-1'], fetchMessages, transcriptRows: () => [] })).toBe(0);
    expect(fetchMessages).not.toHaveBeenCalled();

    await setLocalPlaintext(db, 'old', { plaintext: 'a', timestamp: 1 });
    const refused = vi.fn().mockRejectedValue(Object.assign(new Error('not a channel member'), { status: 403 }));
    expect(await sweepLegacyPlaintextTags({ db, token: 't', serverId: 's', channelIds: ['ch-1'], fetchMessages: refused, transcriptRows: () => [] })).toBe(0);
    const state = await getLocalPlaintextTagState(db);
    expect(state.swept.size).toBe(0);
    expect([...state.untagged]).toEqual(['old']);
    db.close();
  });

  it('M3: a received legacy "ok" in Space B is never tagged by Space S\'s sweep and survives removal from S', async () => {
    // Review round 3 repro. The older build cached every received message as
    // { plaintext, timestamp } only: no sender, no channel.
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 2, 9);
    await setLocalPlaintext(db, 'x-in-b', { plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    await setLocalPlaintext(db, 'y-in-s', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 180_000 });
    const pages = { 'ch-s': [[msg('y-in-s', T + 180_000)]] };
    const fetchMessages = vi.fn(async (_t, _s, c) => pages[c]?.shift() ?? []);
    // Only S's sweep runs (B's is slower, offline, refused or past maxPages).
    expect(await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-s', channelIds: ['ch-s'], fetchMessages, transcriptRows: () => [] })).toBe(1);
    expect(await getLocalPlaintext(db, 'y-in-s')).toMatchObject({ channelId: 'ch-s' });
    expect((await getLocalPlaintext(db, 'x-in-b')).channelId).toBeUndefined();
    expect(await deleteLocalPlaintextsForChannels(db, ['ch-s'])).toEqual(['y-in-s']);
    expect(await getLocalPlaintext(db, 'x-in-b')).toEqual({ plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    db.close();
  });

  it('attributes a legacy row by its exact server message id: B\'s history tags it ch-b, removal from S keeps it, removal from B purges it', async () => {
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 2, 9);
    await setLocalPlaintext(db, 'x-in-b', { plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    await setLocalPlaintext(db, 'y-in-s', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 180_000 });
    const pages = { 'ch-s': [[msg('y-in-s', T + 180_000)]], 'ch-b': [[msg('x-in-b', T)]] };
    const fetchMessages = vi.fn(async (_t, _s, c) => pages[c]?.shift() ?? []);
    await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-s', channelIds: ['ch-s'], fetchMessages, transcriptRows: () => [] });
    await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-b', channelIds: ['ch-b'], fetchMessages, transcriptRows: () => [] });
    expect(await getLocalPlaintext(db, 'x-in-b')).toMatchObject({ channelId: 'ch-b' });
    expect(await deleteLocalPlaintextsForChannels(db, ['ch-s'])).toEqual(['y-in-s']);
    expect(await getLocalPlaintext(db, 'x-in-b')).toMatchObject({ plaintext: '{"v":1,"text":"ok"}', channelId: 'ch-b' });
    expect(await deleteLocalPlaintextsForChannels(db, ['ch-b'])).toEqual(['x-in-b']);
    expect(await getLocalPlaintext(db, 'x-in-b')).toBeNull();
    db.close();
  });

  it('leaves an unattributable random-id self-send copy untagged; it survives the removal of every other Space', async () => {
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 1, 12);
    // Older build: a send cached under crypto.randomUUID() (never sent to the
    // server) and, at the ack, under the real id. Only the real id is in history.
    await setLocalPlaintext(db, 'rand-1', { plaintext: '{"v":1,"text":"hi"}', timestamp: T });
    await setLocalPlaintext(db, 'real-1', { plaintext: '{"text":"hi","v":1}', timestamp: T + 2000 });
    const pages = { 'ch-s': [[msg('real-1', T + 2000)]], 'ch-b': [[]] };
    const fetchMessages = vi.fn(async (_t, _s, c) => pages[c]?.shift() ?? []);
    expect(await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-s', channelIds: ['ch-s'], fetchMessages, transcriptRows: () => [] })).toBe(1);
    // No exact key names rand-1, so no content/time guess tags it, even with
    // its real copy tagged two seconds away.
    expect((await getLocalPlaintext(db, 'rand-1')).channelId).toBeUndefined();
    await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-b', channelIds: ['ch-b'], fetchMessages, transcriptRows: () => [] });
    expect((await getLocalPlaintext(db, 'rand-1')).channelId).toBeUndefined();
    expect(await deleteLocalPlaintextsForChannels(db, ['ch-b'])).toEqual([]);
    expect(await deleteLocalPlaintextsForChannels(db, ['ch-s'])).toEqual(['real-1']);
    expect(await getLocalPlaintext(db, 'rand-1')).toEqual({ plaintext: '{"v":1,"text":"hi"}', timestamp: T });
    db.close();
  });

  it('purges every row tagged with the evicted Space (plaintext and tag-only vault rows) and nothing else', async () => {
    const db = await nextDb();
    await setLocalPlaintext(db, 's-1', { plaintext: 'a', timestamp: 1, channelId: 'ch-s' });
    await setLocalPlaintext(db, 's-2', { plaintext: 'b', timestamp: 2, channelId: 'ch-s2' });
    await tagLocalPlaintext(db, 'vault-s', 'ch-s');
    await setLocalPlaintext(db, 'b-1', { plaintext: 'c', timestamp: 3, channelId: 'ch-b' });
    await setLocalPlaintext(db, 'legacy', { plaintext: 'd', timestamp: 4 });
    expect((await deleteLocalPlaintextsForChannels(db, ['ch-s', 'ch-s2'])).sort()).toEqual(['s-1', 's-2', 'vault-s']);
    expect((await listAllLocalPlaintexts(db)).map((r) => r.messageId).sort()).toEqual(['b-1', 'legacy']);
    db.close();
  });
});
