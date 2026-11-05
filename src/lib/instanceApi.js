/**
 * Instance API factory.
 *
 * Binds a baseUrl and a getToken callback to all MLS/chat/transparency api.js
 * functions so call-sites don't have to thread those values manually.
 *
 * Usage:
 *   const api = createInstanceApi('https://remote.instance.example.com', () => getToken());
 *   api.getMLSGroupInfo(token, channelId);   // token forwarded, baseUrl injected
 *
 * Backwards compatibility with mlsGroup.js:
 *   mlsGroup.js calls every method as api.method(token, ...args) - passing the
 *   token explicitly. The factory honours that: when a truthy token is supplied
 *   as the first argument, it is used as-is; otherwise getToken() is called.
 *   This avoids any change to mlsGroup.js.
 */

import * as apiModule from './api';

/**
 * Creates a bound API object for a single remote instance.
 *
 * @param {string} baseUrl - Base URL of the target instance (e.g. 'https://remote.example.com').
 *   Pass '' for same-origin / current instance.
 * @param {() => string | null} getToken - Called at invocation time to obtain the current JWT.
 *   Only invoked when the caller does not supply an explicit token as the first argument.
 * @returns {object} Bound API object with all MLS/chat/transparency methods.
 */
export function createInstanceApi(baseUrl, getToken) {
  /**
   * Resolves the token to use for a call.
   * If the caller explicitly passes a truthy token, use it directly.
   * Otherwise, call getToken() to obtain the current session token.
   *
   * @param {string | null | undefined} callerToken
   * @returns {string | null}
   */
  function tok(callerToken) {
    if (callerToken !== undefined && callerToken !== null) {
      return callerToken;
    }
    return getToken();
  }

  return {
    // ── MLS Group ─────────────────────────────────────────────────────────────

    /** @param {string|null} token @param {string} channelId */
    getMLSGroupInfo: (token, channelId) =>
      apiModule.getMLSGroupInfo(tok(token), channelId, baseUrl),

    /** @param {string|null} token @param {string} channelId @param {string} groupInfoBase64 @param {number} epoch */
    putMLSGroupInfo: (token, channelId, groupInfoBase64, epoch) =>
      apiModule.putMLSGroupInfo(tok(token), channelId, groupInfoBase64, epoch, baseUrl),

    /** @param {string|null} token @param {string} channelId @param {string} commitBytesBase64 @param {string} groupInfoBase64 @param {number} epoch */
    postMLSCommit: (token, channelId, commitBytesBase64, groupInfoBase64, epoch, opts) =>
      apiModule.postMLSCommit(tok(token), channelId, commitBytesBase64, groupInfoBase64, epoch, baseUrl, ...(opts ? [opts] : [])),

    /** @param {string|null} token @param {string} channelId @param {number} sinceEpoch @param {number} [limit=100] */
    getMLSCommitsSinceEpoch: (token, channelId, sinceEpoch, limit = 100) =>
      apiModule.getMLSCommitsSinceEpoch(tok(token), channelId, sinceEpoch, limit, baseUrl),

    // ── MLS Pending Welcomes ─────────────────────────────────────────────────

    /** @param {string|null} token */
    getMLSPendingWelcomes: (token) =>
      apiModule.getMLSPendingWelcomes(tok(token), baseUrl),

    /** @param {string|null} token @param {string} welcomeId */
    deleteMLSPendingWelcome: (token, welcomeId) =>
      apiModule.deleteMLSPendingWelcome(tok(token), welcomeId, baseUrl),

    // ── Guild Metadata Group ─────────────────────────────────────────────────

    /** @param {string|null} token @param {string} guildId */
    getGuildMetadataGroupInfo: (token, guildId) =>
      apiModule.getGuildMetadataGroupInfo(tok(token), guildId, baseUrl),

    /** @param {string|null} token @param {string} guildId @param {string} groupInfoBase64 @param {number} epoch */
    putGuildMetadataGroupInfo: (token, guildId, groupInfoBase64, epoch) =>
      apiModule.putGuildMetadataGroupInfo(tok(token), guildId, groupInfoBase64, epoch, baseUrl),

    // ── MLS Voice Group ──────────────────────────────────────────────────────

    /** @param {string|null} token @param {string} channelId */
    getMLSVoiceGroupInfo: (token, channelId) =>
      apiModule.getMLSVoiceGroupInfo(tok(token), channelId, baseUrl),

    /** @param {string|null} token @param {string} channelId @param {string} groupInfoBase64 @param {number} epoch */
    putMLSVoiceGroupInfo: (token, channelId, groupInfoBase64, epoch) =>
      apiModule.putMLSVoiceGroupInfo(tok(token), channelId, groupInfoBase64, epoch, baseUrl),

    /** @param {string|null} token @param {string} channelId @param {string} commitBytesBase64 @param {number} epoch @param {string} groupInfoBase64 */
    postMLSVoiceCommit: (token, channelId, commitBytesBase64, epoch, groupInfoBase64) =>
      apiModule.postMLSVoiceCommit(tok(token), channelId, commitBytesBase64, epoch, groupInfoBase64, baseUrl),

    // ── Key Packages ─────────────────────────────────────────────────────────

    /** @param {string|null} token @param {{ deviceId: string, keyPackages: number[][], expiresAt?: string, lastResort?: boolean }} body */
    uploadMLSKeyPackages: (token, body) =>
      apiModule.uploadMLSKeyPackages(tok(token), body, baseUrl),

    /** @param {string|null} token @param {string} deviceId */
    getKeyPackageCount: (token, deviceId) =>
      apiModule.getKeyPackageCount(tok(token), deviceId, baseUrl),

    // ── Channel Messages ─────────────────────────────────────────────────────

    /** @param {string|null} token @param {string} serverId @param {string} channelId @param {{ before?: string, after?: string, limit?: number }} [opts] */
    getChannelMessages: (token, serverId, channelId, opts = {}) =>
      apiModule.getChannelMessages(tok(token), serverId, channelId, opts, baseUrl),

    // ── Transparency ─────────────────────────────────────────────────────────

    /** @param {string|null} token @param {string} pubkeyHex */
    verifyTransparency: (token, pubkeyHex) =>
      apiModule.verifyTransparency(tok(token), pubkeyHex, baseUrl),

    // ── Pre-Key Bundles ──────────────────────────────────────────────────────

    /** @param {string|null} token @param {string} userId */
    getPreKeyBundle: (token, userId) =>
      apiModule.getPreKeyBundle(tok(token), userId, baseUrl),

    /** @param {string|null} token @param {string} userId @param {string} deviceId */
    getPreKeyBundleByDevice: (token, userId, deviceId) =>
      apiModule.getPreKeyBundleByDevice(tok(token), userId, deviceId, baseUrl),
  };
}
