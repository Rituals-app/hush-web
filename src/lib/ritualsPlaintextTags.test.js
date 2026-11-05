import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  openStore,
  setLocalPlaintext,
  getLocalPlaintextTagState,
  deleteLocalPlaintextsForChannels,
  getLocalPlaintext,
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
});
