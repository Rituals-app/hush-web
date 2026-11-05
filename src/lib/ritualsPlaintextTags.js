// @ts-check
/**
 * Rituals fork (2026-11-05): tag legacy cached plaintext with its Space.
 *
 * Plaintext cached before the channel tag existed (localPlaintext rows and
 * transcript-vault entries from a linked device) carries no channel, so a
 * removal from a Space could not find it. While this person is still a member,
 * this sweep pages through each of the Space's channels once and tags every
 * untagged message it finds there. It only tags; it never deletes, so nobody's
 * history changes. A channel is marked swept once its history is read to the
 * end, and the sweep does no network work when nothing is untagged.
 *
 * The only key is the exact server message id: a row is tagged with a channel
 * only when that channel's history returns its id. Nothing is matched by
 * content or time. Rows the history never names (random-id self-send copies
 * from older builds, rows past maxPages, channels this person has left) stay
 * untagged, and a removal never deletes an untagged row.
 */

import * as mlsStore from './mlsStore';
import { getChannelMessages } from './api';
import { listTranscriptCacheEntries } from './transcriptVault';

const PAGE_LIMIT = 50;

/**
 * @param {{
 *   db: IDBDatabase,
 *   token: string,
 *   serverId: string,
 *   channelIds: readonly string[],
 *   baseUrl?: string,
 *   fetchMessages?: typeof getChannelMessages,
 *   transcriptRows?: () => Array<{ messageId: string, channelId?: string }>,
 *   maxPages?: number,
 * }} args
 * @returns {Promise<number>} rows tagged
 */
export async function sweepLegacyPlaintextTags({
  db,
  token,
  serverId,
  channelIds,
  baseUrl = '',
  fetchMessages = getChannelMessages,
  transcriptRows = listTranscriptCacheEntries,
  maxPages = 40,
}) {
  let tagged = 0;
  const state = await mlsStore.getLocalPlaintextTagState(db);
  const pending = new Set(state.untagged);
  for (const row of transcriptRows()) {
    if (row?.messageId && !row.channelId && !state.tagged.has(row.messageId)) pending.add(row.messageId);
  }
  for (const channelId of channelIds) {
    if (!pending.size) break;
    if (state.swept.has(channelId)) continue;
    let before;
    let complete = false;
    try {
      for (let page = 0; page < maxPages; page++) {
        const rows = await fetchMessages(
          token,
          serverId,
          channelId,
          { limit: PAGE_LIMIT, ...(before ? { before } : {}) },
          baseUrl,
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          complete = true;
          break;
        }
        let oldest = null;
        for (const row of rows) {
          if (row?.id && pending.has(row.id)) {
            pending.delete(row.id);
            // Defense in depth: a row tagged since the state was read (another
            // Space's sweep, a read) keeps its tag; never re-tag across Spaces.
            const existing = await mlsStore.getLocalPlaintextChannelTag(db, row.id);
            if (existing && existing !== channelId) continue;
            if (!existing) {
              await mlsStore.tagLocalPlaintext(db, row.id, channelId);
              tagged++;
            }
          }
          const ts = Date.parse(row?.timestamp);
          if (Number.isFinite(ts) && (oldest == null || ts < oldest)) oldest = ts;
        }
        if (!pending.size) break;
        if (rows.length < PAGE_LIMIT || oldest == null) {
          complete = true;
          break;
        }
        before = new Date(oldest).toISOString();
      }
    } catch {
      // Refused (no longer a member) or offline: try again on the next mount.
      continue;
    }
    if (complete) await mlsStore.markPlaintextTagSweep(db, channelId);
  }
  return tagged;
}
