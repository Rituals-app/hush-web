import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  openStore,
  setLocalPlaintext,
  getLocalPlaintextTagState,
  deleteLocalPlaintextsForChannels,
  getLocalPlaintext,
  listAllLocalPlaintexts,
  tagSelfSendCopies,
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

  it('tags legacy random-id self-send rows with their real copy\'s channel, so a removal deletes them too', async () => {
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 1, 12);
    // Before this release a send cached its plaintext under crypto.randomUUID()
    // (encodeEnvelopeV1 key order) and, at the ack, again under the real id
    // (JSON.stringify of the pending envelope, server time). Neither had a channel.
    await setLocalPlaintext(db, 'rand-1', { plaintext: '{"v":1,"text":"hi","replyTo":"m0"}', timestamp: T });
    await setLocalPlaintext(db, 'real-1', { plaintext: '{"replyTo":"m0","text":"hi","v":1}', timestamp: T + 2000 });
    // Same text, but sent in two Spaces within the window: ambiguous, left alone.
    await setLocalPlaintext(db, 'rand-ok', { plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    await setLocalPlaintext(db, 'ok-s', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 1000, channelId: 'ch-1' });
    await setLocalPlaintext(db, 'ok-t', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 5000, channelId: 'ch-9' });
    // Someone else's pre-decrypted row is never matched by content.
    await setLocalPlaintext(db, 'other', { plaintext: '{"v":1,"text":"hi","replyTo":"m0"}', timestamp: T, senderId: 'u2' });

    const pages = { 'ch-1': [[msg('real-1', T + 2000), msg('other', T)]] };
    const fetchMessages = vi.fn(async (_t, _s, channelId) => pages[channelId]?.shift() ?? []);
    const tagged = await sweepLegacyPlaintextTags({ db, token: 't', serverId: 's', channelIds: ['ch-1'], fetchMessages, transcriptRows: () => [] });
    expect(tagged).toBe(3);
    expect([...(await getLocalPlaintextTagState(db)).untagged]).toEqual(['rand-ok']);

    // Eviction from ch-1 leaves nothing of the self-send behind.
    await deleteLocalPlaintextsForChannels(db, ['ch-1']);
    const left = (await listAllLocalPlaintexts(db)).map((r) => r.messageId).sort();
    expect(left).toEqual(['ok-t', 'rand-ok']);
    db.close();
  });

  it('tags random-id copies without any request once their real copy is already tagged', async () => {
    const db = await nextDb();
    await setLocalPlaintext(db, 'real', { plaintext: '{"v":1,"text":"yo"}', timestamp: 5000, channelId: 'ch-1' });
    await setLocalPlaintext(db, 'rand', { plaintext: '{"v":1,"text":"yo"}', timestamp: 4000 });
    // A copy stored more than a day later is not the same send.
    await setLocalPlaintext(db, 'later', { plaintext: '{"v":1,"text":"yo"}', timestamp: 5000 + 2 * 86_400_000 });
    const fetchMessages = vi.fn(async () => []);
    // Another Space's sweep never attributes rows to ch-1.
    expect(await tagSelfSendCopies(db, ['ch-9'])).toBe(0);
    expect(await sweepLegacyPlaintextTags({ db, token: 't', serverId: 's', channelIds: ['ch-1'], fetchMessages, transcriptRows: () => [] })).toBe(1);
    expect(await getLocalPlaintext(db, 'rand')).toMatchObject({ channelId: 'ch-1' });
    expect((await getLocalPlaintext(db, 'later')).channelId).toBeUndefined();
    db.close();
  });
  it('M2: the same "ok" sent by the same user in two Spaces stays with its own Space through a removal', async () => {
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 2, 9);
    // Legacy send in Space B (not swept yet): untagged random-id and real-id copies.
    await setLocalPlaintext(db, 'rand-b', { plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    await setLocalPlaintext(db, 'real-b', { plaintext: '{"text":"ok","v":1}', timestamp: T + 1500 });
    // Six hours later, "ok" in Space S on the new release: both copies tagged at write.
    await setLocalPlaintext(db, 'rand-s', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 6 * 3600_000, channelId: 'ch-s' });
    await setLocalPlaintext(db, 'real-s', { plaintext: '{"text":"ok","v":1}', timestamp: T + 6 * 3600_000 + 900, channelId: 'ch-s' });

    const pages = { 'ch-s': [[msg('real-s', T + 6 * 3600_000)]], 'ch-b': [[msg('real-b', T + 1500)]] };
    const fetchMessages = vi.fn(async (_t, _s, channelId) => pages[channelId]?.shift() ?? []);
    // Space S's sweep runs first and must not claim B's rows.
    await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-s', channelIds: ['ch-s'], fetchMessages, transcriptRows: () => [] });
    expect((await getLocalPlaintext(db, 'rand-b')).channelId).toBeUndefined();
    expect((await getLocalPlaintext(db, 'real-b')).channelId).toBeUndefined();

    // Space B's own sweep tags its pair with B.
    await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-b', channelIds: ['ch-b'], fetchMessages, transcriptRows: () => [] });
    expect(await getLocalPlaintext(db, 'real-b')).toMatchObject({ plaintext: '{"text":"ok","v":1}', channelId: 'ch-b' });
    expect(await getLocalPlaintext(db, 'rand-b')).toMatchObject({ channelId: 'ch-b' });

    // Removal from S deletes only S's copies; B's row is intact and still B's.
    expect((await deleteLocalPlaintextsForChannels(db, ['ch-s'])).sort()).toEqual(['rand-s', 'real-s']);
    expect(await getLocalPlaintext(db, 'real-b')).toMatchObject({ plaintext: '{"text":"ok","v":1}', channelId: 'ch-b' });
    // Removal from B then deletes B's copies too.
    expect((await deleteLocalPlaintextsForChannels(db, ['ch-b'])).sort()).toEqual(['rand-b', 'real-b']);
    db.close();
  });

  it('M2: "ok" sent in two Spaces minutes apart is never cross-tagged; the ambiguous random copy is left untagged', async () => {
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 2, 9);
    await setLocalPlaintext(db, 'rand-b', { plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    await setLocalPlaintext(db, 'real-b', { plaintext: '{"text":"ok","v":1}', timestamp: T + 1500 });
    await setLocalPlaintext(db, 'rand-s', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 60_000, channelId: 'ch-s' });
    await setLocalPlaintext(db, 'real-s', { plaintext: '{"text":"ok","v":1}', timestamp: T + 61_000, channelId: 'ch-s' });
    const pages = { 'ch-b': [[msg('real-b', T + 1500)]] };
    const fetchMessages = vi.fn(async (_t, _s, channelId) => pages[channelId]?.shift() ?? []);
    expect(await tagSelfSendCopies(db, ['ch-s'])).toBe(0);
    await sweepLegacyPlaintextTags({ db, token: 't', serverId: 'srv-b', channelIds: ['ch-b'], fetchMessages, transcriptRows: () => [] });
    expect(await getLocalPlaintext(db, 'real-b')).toMatchObject({ channelId: 'ch-b' });
    // Tagged copies in both Spaces sit next to it: no stronger key, so no tag.
    expect((await getLocalPlaintext(db, 'rand-b')).channelId).toBeUndefined();
    expect(await tagSelfSendCopies(db, ['ch-s'])).toBe(0);
    await deleteLocalPlaintextsForChannels(db, ['ch-s']);
    expect(await getLocalPlaintext(db, 'real-b')).toMatchObject({ plaintext: '{"text":"ok","v":1}', channelId: 'ch-b' });
    db.close();
  });

  it('leaves ambiguous same-Space copies untagged (two identical untagged sends, one tagged real copy)', async () => {
    const db = await nextDb();
    const T = Date.UTC(2026, 10, 3, 9);
    await setLocalPlaintext(db, 'real-1', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 1000, channelId: 'ch-1' });
    await setLocalPlaintext(db, 'rand-1', { plaintext: '{"v":1,"text":"ok"}', timestamp: T });
    // A second identical untagged row (a retry, or a second "ok"): which one
    // is real-1's twin cannot be told, so neither is tagged.
    await setLocalPlaintext(db, 'rand-2', { plaintext: '{"v":1,"text":"ok"}', timestamp: T + 30_000 });
    // A failed attempt retried an hour later is likewise left alone.
    await setLocalPlaintext(db, 'real-h', { plaintext: '{"v":1,"text":"hi"}', timestamp: T + 1000, channelId: 'ch-1' });
    await setLocalPlaintext(db, 'rand-h', { plaintext: '{"v":1,"text":"hi"}', timestamp: T });
    await setLocalPlaintext(db, 'rand-h0', { plaintext: '{"v":1,"text":"hi"}', timestamp: T - 3600_000 });
    expect(await tagSelfSendCopies(db, ['ch-1'])).toBe(0);
    const state = await getLocalPlaintextTagState(db);
    expect([...state.untagged].sort()).toEqual(['rand-1', 'rand-2', 'rand-h', 'rand-h0']);
    // Left untagged, a removal does not touch them.
    expect((await deleteLocalPlaintextsForChannels(db, ['ch-1'])).sort()).toEqual(['real-1', 'real-h']);
    expect((await listAllLocalPlaintexts(db)).map((r) => r.messageId).sort()).toEqual(['rand-1', 'rand-2', 'rand-h', 'rand-h0']);
    db.close();
  });
});
