/**
 * Old-device link-export pre-decrypt.
 *
 * Runs on the OLD device immediately before the device-link snapshot is
 * captured. Walks every text channel the old device is currently a member
 * of, fetches the historical messages from the server, and best-effort
 * decrypts each one against the OLD device's active MLS store using the
 * normal active-store decrypt path. Successful plaintexts are written into
 * the active DB's `localPlaintext` table along with their `senderId`.
 *
 * Why this is the right layer:
 *
 * MLS application messages can only be decrypted by a member device whose
 * group state still holds the per-sender ratchet generation that signed
 * them. By the time a freshly linked device imports the snapshot, the
 * snapshot's ratchet state is frozen at the OLD device's then-current
 * epoch, and any message older than the ratchet retention window will fail
 * with `TooDistantInThePast` even with a perfect import. Pre-decrypting on
 * the OLD device cannot teleport beyond that window either, but it does
 * harvest every message that was still inside the OLD device's working
 * window at link time — and crucially it does so against the OLD device's
 * own active StorageProvider, with no cross-DB bridge swaps.
 *
 * The harvested plaintexts ride along inside the existing
 * `historySnapshot.localPlaintext` rows that `exportHistorySnapshot`
 * already serialises. On the new device, `useMLS.getCachedMessage` already
 * falls back to the imported history DB's `localPlaintext`, so no runtime
 * decrypt-path change is needed: the new device just sees them as cached
 * plaintexts on first render.
 *
 * The pre-decrypt is best-effort: per-message `TooDistantInThePast` /
 * `WrongEpoch` failures are expected (forward secrecy) and never abort the
 * link approval flow.
 */

import * as mlsGroupLib from './mlsGroup';
import * as mlsStoreLib from './mlsStore';
import * as hushCryptoLib from './hushCrypto';
import * as apiLib from './api';

const PAGE_LIMIT = 100;
const MAX_CHANNELS_PER_GUILD = 200;
const PAGE_FETCH_HARD_CAP = 200;

/**
 * Decode a base64 string into a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Page through `getChannelMessages` until exhausted. Uses the oldest
 * timestamp in each page as the cursor for the next page. Caller is
 * responsible for chronologically sorting the combined result.
 *
 * @param {object} api
 * @param {string} token
 * @param {string} serverId
 * @param {string} channelId
 * @param {string} baseUrl
 * @returns {Promise<Array<object>>}
 */
async function fetchAllMessages(api, token, serverId, channelId, baseUrl) {
  const all = [];
  let before = null;
  for (let i = 0; i < PAGE_FETCH_HARD_CAP; i++) {
    const opts = { limit: PAGE_LIMIT };
    if (before) opts.before = before;
    const page = await api.getChannelMessages(token, serverId, channelId, opts, baseUrl);
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    const oldest = page[page.length - 1];
    if (!oldest?.timestamp) break;
    before = oldest.timestamp;
  }
  return all;
}

/**
 * Enumerate `(guildId, channelId)` text-channel pairs for the user.
 *
 * @param {object} api
 * @param {string} token
 * @param {string} baseUrl
 * @returns {Promise<Array<{ guildId: string, channelId: string }>>}
 */
async function listTextChannels(api, token, baseUrl) {
  const out = [];
  let guilds;
  try {
    guilds = await api.getMyGuilds(token, baseUrl);
  } catch (err) {
    console.warn('[preDecryptForLinkExport] getMyGuilds failed:', err);
    return out;
  }
  if (!Array.isArray(guilds)) return out;

  for (const guild of guilds) {
    if (!guild?.id) continue;
    let channels;
    try {
      channels = await api.getGuildChannels(token, guild.id, baseUrl);
    } catch (err) {
      console.warn('[preDecryptForLinkExport] getGuildChannels failed for guild', guild.id, err);
      continue;
    }
    if (!Array.isArray(channels)) continue;
    let count = 0;
    for (const ch of channels) {
      if (!ch?.id || ch.type !== 'text') continue;
      out.push({ guildId: guild.id, channelId: ch.id });
      if (++count >= MAX_CHANNELS_PER_GUILD) break;
    }
  }
  return out;
}

/**
 * Decrypt a single message via the OLD device's active MLS store using the
 * standard `decryptMessage` (with one `catchupCommits` retry on transient
 * failure, mirroring `useMLS.decryptFromChannel`). Returns null on every
 * failure mode so the caller can keep iterating.
 *
 * @returns {Promise<string|null>}
 */
async function decryptOnce(deps, mlsGroup, channelId, ciphertext) {
  try {
    const result = await mlsGroup.decryptMessage(deps, channelId, ciphertext);
    if (result?.plaintext != null) return result.plaintext;
    return null;
  } catch (primary) {
    try {
      await mlsGroup.catchupCommits(deps, channelId);
      const retry = await mlsGroup.decryptMessage(deps, channelId, ciphertext);
      if (retry?.plaintext != null) return retry.plaintext;
    } catch {
      // fall through
    }
    return null;
  }
}

/**
 * Pre-decrypt every reachable message in one channel and write recovered
 * plaintexts to the active DB's `localPlaintext` cache.
 *
 * @returns {Promise<{ processed: number, decrypted: number, failed: number, skipped: number }>}
 */
async function preDecryptChannel({ activeDb, channelId, messages, deps, mlsGroup, mlsStore }) {
  const stats = { processed: 0, decrypted: 0, failed: 0, skipped: 0 };
  for (const msg of messages) {
    stats.processed++;
    if (!msg?.id || !msg?.ciphertext) {
      stats.skipped++;
      continue;
    }
    const existing = await mlsStore.getLocalPlaintext(activeDb, msg.id).catch(() => null);
    if (existing?.plaintext) {
      stats.skipped++;
      continue;
    }
    let ciphertext;
    try {
      ciphertext = base64ToBytes(msg.ciphertext);
    } catch {
      stats.failed++;
      continue;
    }
    const plaintext = await decryptOnce(deps, mlsGroup, channelId, ciphertext);
    if (plaintext == null) {
      stats.failed++;
      continue;
    }
    const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    try {
      await mlsStore.setLocalPlaintext(activeDb, msg.id, {
        plaintext,
        senderId: msg.senderId ?? undefined,
        timestamp: ts,
        channelId,
      });
      stats.decrypted++;
    } catch (err) {
      console.warn('[preDecryptForLinkExport] setLocalPlaintext failed for', msg.id, err);
      stats.failed++;
    }
  }
  return stats;
}

/**
 * Pre-decrypt every reachable historical message on the OLD device's
 * active store and persist the plaintexts in the active `localPlaintext`
 * cache. The caller is expected to invoke this immediately before
 * `mlsStore.exportHistorySnapshot(activeDb)` so the freshly cached rows
 * ride along inside the snapshot.
 *
 * Best-effort: returns a summary; never throws upward.
 *
 * @param {{
 *   activeDb: IDBDatabase,
 *   token: string,
 *   baseUrl?: string,
 *   _deps?: object,
 * }} args
 * @returns {Promise<{ channels: number, processed: number, decrypted: number, failed: number, skipped: number }>}
 */
export async function preDecryptForLinkExport({ activeDb, token, baseUrl = '', _deps } = {}) {
  const mlsGroup = _deps?.mlsGroup ?? mlsGroupLib;
  const mlsStore = _deps?.mlsStore ?? mlsStoreLib;
  const hushCrypto = _deps?.hushCrypto ?? hushCryptoLib;
  const api = _deps?.api ?? apiLib;

  const summary = { channels: 0, processed: 0, decrypted: 0, failed: 0, skipped: 0 };
  if (!activeDb || !token) return summary;

  const credential = await mlsStore.getCredential(activeDb).catch(() => null);
  if (!credential) {
    console.warn('[preDecryptForLinkExport] active credential missing; skipping pre-decrypt');
    return summary;
  }

  const channels = await listTextChannels(api, token, baseUrl);
  summary.channels = channels.length;
  if (channels.length === 0) return summary;

  const deps = { db: activeDb, token, credential, mlsStore, hushCrypto, api, baseUrl };

  for (const { guildId, channelId } of channels) {
    let messages;
    try {
      messages = await fetchAllMessages(api, token, guildId, channelId, baseUrl);
    } catch (err) {
      console.warn('[preDecryptForLinkExport] fetchAllMessages failed for', channelId, err);
      continue;
    }
    if (!messages?.length) continue;
    messages.sort((a, b) => {
      const at = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
      const bt = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
      return at - bt;
    });
    let stats;
    try {
      stats = await preDecryptChannel({
        activeDb,
        channelId,
        messages,
        deps,
        mlsGroup,
        mlsStore,
      });
    } catch (err) {
      console.warn('[preDecryptForLinkExport] channel pre-decrypt failed for', channelId, err);
      continue;
    }
    summary.processed += stats.processed;
    summary.decrypted += stats.decrypted;
    summary.failed += stats.failed;
    summary.skipped += stats.skipped;
  }

  return summary;
}
