/**
 * MLS session hook - Phase M.3 channel-centric API only.
 *
 * Provides the channel-centric crypto API (MLS group):
 *    encryptForChannel(plaintext) -> { ciphertext: Uint8Array, localId: string }
 *    decryptFromChannel(messageBytes) -> string
 *    getCachedMessage(messageId) -> { content, senderId, timestamp } | null
 *    setCachedMessage(messageId, payload) -> void
 *
 * User-centric passthrough stubs (encryptForUser, decryptFromUser) have been removed.
 * Voice E2EE uses MLS voice groups - see mlsGroup.js (createVoiceGroup, joinVoiceGroup,
 * exportVoiceFrameKey, performVoiceSelfUpdate, destroyVoiceGroup).
 */

import * as mlsGroupLib from '../lib/mlsGroup';
import * as mlsStoreLib from '../lib/mlsStore';
import * as hushCryptoLib from '../lib/hushCrypto';
import * as apiLib from '../lib/api';
import { getTranscriptEntry } from '../lib/transcriptVault';
import { withChannelMLSMutex, textChannelKey } from '../lib/channelMLSMutex';

/**
 * @param {object} opts
 * @param {() => Promise<IDBDatabase|null>} opts.getStore - Opens IndexedDB for the current user
 * @param {() => Promise<IDBDatabase|null>} [opts.getHistoryStore] - Optional history-tier IDB factory
 * @param {() => string|null} opts.getToken - Returns the JWT for API calls
 * @param {string} [opts.channelId] - Required for encryptForChannel/decryptFromChannel
 * @param {string} [opts.baseUrl] - Owning instance base URL. Threaded into MLS deps so cross-instance
 *   catch-up requests target the per-instance JWT's owning origin instead of falling back to
 *   `window.location.origin` (a JWT leak vector when the user has joined a non-home instance).
 * @param {object} [opts._deps] - Optional dep injection for testing
 * @returns {{
 *   encryptForChannel: Function,
 *   decryptFromChannel: Function,
 *   getCachedMessage: Function,
 *   setCachedMessage: Function,
 * }}
 */
export function useMLS({ getStore, getHistoryStore, getToken, channelId, baseUrl = '', _deps }) {
  const mlsGroup = _deps?.mlsGroup ?? mlsGroupLib;
  const mlsStore = _deps?.mlsStore ?? mlsStoreLib;
  const hushCrypto = _deps?.hushCrypto ?? hushCryptoLib;
  const api = _deps?.api ?? apiLib;

  // ---------------------------------------------------------------------------
  // Shared deps builder - opens DB and loads credential on each call.
  // Lazy: only called when an MLS operation is actually needed.
  // ---------------------------------------------------------------------------

  /**
   * Builds the deps object required by mlsGroup functions.
   * @returns {Promise<object>}
   */
  async function buildDeps() {
    const db = await getStore();
    const token = getToken();
    if (!db) throw new Error('[useMLS] No IDB store available');
    if (!token) throw new Error('[useMLS] No auth token available');
    const credential = await mlsStore.getCredential(db);
    return { db, token, credential, mlsStore, hushCrypto, api, baseUrl };
  }

  // ---------------------------------------------------------------------------
  // Channel-centric API (MLS group)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt plaintext for the channel MLS group.
   * Returns a single ciphertext Uint8Array - no fan-out.
   *
   * @param {string} plaintext
   * @returns {Promise<{ ciphertext: Uint8Array, localId: string }>}
   */
  async function encryptForChannel(plaintext) {
    if (!channelId) throw new Error('[useMLS] channelId is required for encryptForChannel');
    const deps = await buildDeps();
    // Serialise stateful MLS ops per channel to prevent racing with WS commit
    // handlers, catchup runs, or the decrypt-retry path.
    const { messageBytes, localId } = await withChannelMLSMutex(textChannelKey(channelId), () =>
      mlsGroup.encryptMessage(deps, channelId, plaintext),
    );
    return { ciphertext: messageBytes, localId };
  }

  /**
   * Decrypt a received MLS message from the channel group.
   *
   * @param {Uint8Array} messageBytes
   * @returns {Promise<string>}
   */
  async function decryptFromChannel(messageBytes) {
    if (!channelId) throw new Error('[useMLS] channelId is required for decryptFromChannel');
    const deps = await buildDeps();
    // Hold the per-channel mutex across the whole decrypt-then-retry chain so
    // a concurrent WS commit handler, encrypt, or peer decrypt cannot
    // interleave its own processMessage between our two attempts.
    return withChannelMLSMutex(textChannelKey(channelId), async () => {
      try {
        const result = await mlsGroup.decryptMessage(deps, channelId, messageBytes);
        if (result.plaintext == null) {
          throw new Error(`[useMLS] decryptFromChannel: non-application message (type=${result.type})`);
        }
        return result.plaintext;
      } catch (primaryErr) {
        try {
          await mlsGroup.catchupCommits(deps, channelId);
          const retryResult = await mlsGroup.decryptMessage(deps, channelId, messageBytes);
          if (retryResult.plaintext != null) {
            return retryResult.plaintext;
          }
        } catch {
          // Fall through to the final failure path.
        }
        // Intentionally do not run history-store decrypt here. decryptMessage()
        // is stateful and uses the global StorageProvider bridge, so running it
        // against history state would risk corrupting the active MLS store.
        throw primaryErr;
      }
    });
  }

  /**
   * Retrieve a cached plaintext entry for a self-sent or pre-decrypted
   * legacy message. The link-time legacy pre-decrypt path writes entries
   * with an explicit `senderId`; legacy self-send entries do not, in which
   * case the sender field is undefined and the caller falls back to the
   * server-provided sender on the message row.
   *
   * @param {string} messageId
   * @returns {Promise<{ content: string, senderId?: string, timestamp: number }|null>}
   */
  async function getCachedMessage(messageId) {
    try {
      const db = await getStore();
      if (db) {
        const row = await mlsStore.getLocalPlaintext(db, messageId);
        if (row) {
          // Rituals fork: tag legacy rows with this channel so a removal can
          // delete them (mlsStore.deleteLocalPlaintextsForChannels).
          if (channelId && !row.channelId) {
            mlsStore.setLocalPlaintext(db, messageId, { ...row, channelId }).catch(() => {});
          }
          return {
            content: row.plaintext,
            timestamp: row.timestamp,
            ...(row.senderId ? { senderId: row.senderId } : {}),
          };
        }
      }
      // Encrypted-transcript fallback. The transcript cache is populated from
      // the per-user transcript IDB blob at vault unlock; entries here come
      // from the inherited transcript transferred during device link or from
      // a previous unlock on this device. The cache is cleared on lock.
      const transcriptRow = getTranscriptEntry(messageId);
      if (transcriptRow) {
        return {
          content: transcriptRow.plaintext,
          timestamp: transcriptRow.timestamp,
          ...(transcriptRow.senderId ? { senderId: transcriptRow.senderId } : {}),
        };
      }
      if (typeof getHistoryStore === 'function') {
        const historyDb = await getHistoryStore();
        if (!historyDb) return null;
        const historyRow = await mlsStore.getLocalPlaintext(historyDb, messageId);
        if (historyRow) {
          return {
            content: historyRow.plaintext,
            timestamp: historyRow.timestamp,
            ...(historyRow.senderId ? { senderId: historyRow.senderId } : {}),
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Persist a plaintext entry for a self-sent message.
   * @param {string} messageId
   * @param {{ content: string, senderId?: string, timestamp: number }} payload
   * @returns {Promise<void>}
   */
  async function setCachedMessage(messageId, payload) {
    try {
      const db = await getStore();
      if (!db) return;
      await mlsStore.setLocalPlaintext(db, messageId, {
        plaintext: payload.content ?? payload.plaintext ?? '',
        timestamp: payload.timestamp ?? Date.now(),
        ...(channelId ? { channelId } : {}),
      });
    } catch {
      // Silent - cache errors must never surface to the user.
    }
  }

  /**
   * Rituals fork (2026-11-05): join (or, as the first member, create) this
   * channel's MLS group as soon as the channel is open, instead of only on the
   * first encrypt or decrypt. Without it, the first message in a new space is
   * encrypted before anyone else present has joined, so none of them can read
   * it. Best effort: errors are swallowed and the lazy path stays as fallback.
   * @returns {Promise<void>}
   */
  async function ensureChannelGroup() {
    if (!channelId) return;
    let deps;
    try {
      deps = await buildDeps();
      if (!deps.credential) return;
      await withChannelMLSMutex(textChannelKey(channelId), async () => {
        const epoch = await mlsStore.getGroupEpoch(deps.db, channelId);
        if (epoch == null) await mlsGroup.joinOrCreateChannelGroup(deps, channelId);
        else await mlsGroup.catchupCommits(deps, channelId);
      });
    } catch (err) {
      // Rituals fork (D19d): the server refused this channel (removed from the
      // Space). Drop its group state and cached plaintext; never re-join.
      if (deps && /** @type {{ status?: number }} */ (err)?.status === 403) {
        await mlsGroup.leaveAllChannelGroups(deps, [channelId]).catch(() => {});
      }
      console.warn('[useMLS] ensureChannelGroup failed; joining lazily on the first message instead', {
        channelId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ensureChannelGroup,
    encryptForChannel,
    decryptFromChannel,
    getCachedMessage,
    setCachedMessage,
  };
}
