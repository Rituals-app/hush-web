/**
 * Rituals fork (2026-11-05): one Space identity per Rituals account, carried
 * to a second device by device linking instead of a fresh registration.
 *
 * - The account marker (`rituals_space_account`, the ticket `acct`) binds a
 *   link: a bundle from another Rituals account is refused.
 * - `https://space.rit.al` (native in-app web view) and
 *   `https://space.rituals.app` (framed on the web) are two names for one
 *   Space host, so a link started on one and approved on the other is the
 *   same instance. No other pair of origins is treated as equivalent.
 * - After a link, the device joins the MLS group of every text channel in
 *   the spaces it is seated in (`joinAllChannelGroups`), one channel at a
 *   time under the channel's MLS mutex, skipping channels it already holds.
 */
import { normalizeInstanceUrl } from './authInstanceStore';
import { SPACE_ACCOUNT_KEY, readSpaceTicket, readSpaceTicketHints } from './ritualsSpace';
import { RITUALS_SPACE_ACCOUNT_RE } from './deviceLinking';
import * as mlsGroupLib from './mlsGroup';
import * as mlsStoreLib from './mlsStore';
import * as hushCryptoLib from './hushCrypto';
import * as apiLib from './api';
import { withChannelMLSMutex, textChannelKey } from './channelMLSMutex';

/** The two origins of the one Rituals Space host. */
export const RITUALS_SPACE_ORIGINS = Object.freeze([
  'https://space.rit.al',
  'https://space.rituals.app',
]);

/** Set on a device right after a successful link; consumed by /space. */
const JUST_LINKED_KEY = 'rituals_space_just_linked';
/** Spaces where a linked device should say earlier messages are elsewhere. */
const EARLIER_ELSEWHERE_KEY = 'rituals_space_earlier_elsewhere';

function isRitualsSpaceOrigin(origin) {
  return RITUALS_SPACE_ORIGINS.includes(origin);
}

/**
 * True when two instance URLs name the same Space instance for identity
 * purposes: equal after origin normalisation, or both Rituals Space origins.
 * Anything unparsable is never equivalent.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function isSameLinkInstance(a, b) {
  const left = normalizeInstanceUrl(a);
  const right = normalizeInstanceUrl(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return isRitualsSpaceOrigin(left) && isRitualsSpaceOrigin(right);
}

/** @returns {string|null} this browser's Rituals account marker, if valid */
export function readSpaceAccount() {
  try {
    const value = window.localStorage.getItem(SPACE_ACCOUNT_KEY);
    return typeof value === 'string' && RITUALS_SPACE_ACCOUNT_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The Rituals account this device belongs to: the ticket it was opened with,
 * else the stored marker (written at boot by ensureSpaceAccount).
 * @returns {string|null}
 */
export function currentDeviceSpaceAccount() {
  let ticketAcct = null;
  try {
    ticketAcct = readSpaceTicketHints(readSpaceTicket())?.acct ?? null;
  } catch {
    ticketAcct = null;
  }
  if (typeof ticketAcct === 'string' && RITUALS_SPACE_ACCOUNT_RE.test(ticketAcct)) return ticketAcct;
  return readSpaceAccount();
}

/** Stores the account marker; ignores malformed values. */
export function writeSpaceAccount(acct) {
  if (typeof acct !== 'string' || !RITUALS_SPACE_ACCOUNT_RE.test(acct)) return false;
  try {
    window.localStorage.setItem(SPACE_ACCOUNT_KEY, acct);
    return true;
  } catch {
    return false;
  }
}

/**
 * A link is refused when the bundle names a Rituals account and this device
 * already belongs to a different one. A bundle without `acct` (older
 * approving device, or a plain Hush identity) and a device with no marker
 * yet are both allowed; on success the bundle's marker is stored.
 *
 * @param {string|null|undefined} bundleAcct
 * @param {string|null|undefined} localAcct
 * @returns {boolean}
 */
export function isDeviceLinkAccountMismatch(bundleAcct, localAcct) {
  if (!bundleAcct || !localAcct) return false;
  return bundleAcct !== localAcct;
}

/**
 * Whether /space should offer "Add this device" before creating a fresh
 * identity. Feature-detected: only a ticket hint `seated === true` (this
 * Rituals account already holds a seat in the space, so another device has
 * the identity) turns it on; anything else keeps today's silent
 * registration.
 *
 * @param {{ hasIdentity: boolean, hints: { seated?: boolean }|null }} input
 * @returns {boolean}
 */
export function shouldOfferDeviceLink({ hasIdentity, hints }) {
  if (hasIdentity) return false;
  return hints?.seated === true;
}

function readFlag(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the flag is best effort.
  }
}

/** Called by completeDeviceLink on success. */
export function markDeviceJustLinked() {
  writeFlag(JUST_LINKED_KEY, '1');
}

/** True once after a link; clears the flag. */
export function consumeDeviceJustLinked() {
  const linked = readFlag(JUST_LINKED_KEY) === '1';
  if (linked) writeFlag(JUST_LINKED_KEY, null);
  return linked;
}

function readEarlierElsewhere() {
  try {
    const parsed = JSON.parse(readFlag(EARLIER_ELSEWHERE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Records that this linked device joined `serverId` after others were seated. */
export function markEarlierMessagesElsewhere(serverId) {
  if (typeof serverId !== 'string' || !serverId) return;
  const ids = readEarlierElsewhere();
  if (ids.includes(serverId)) return;
  ids.push(serverId);
  writeFlag(EARLIER_ELSEWHERE_KEY, JSON.stringify(ids.slice(-200)));
}

/** @returns {boolean} whether to say "Earlier messages are on your other device" */
export function hasEarlierMessagesElsewhere(serverId) {
  return typeof serverId === 'string' && readEarlierElsewhere().includes(serverId);
}

/**
 * Joins the MLS group of every text channel in the given spaces after a
 * device link. Needs: a signed-in token for `baseUrl`, this device's own MLS
 * credential (created by the key-package upload during sign-in), and a
 * GroupInfo on the server for each channel (a channel without one is
 * skipped: the first member to open it creates the group). History before
 * the link stays unreadable on this device by design.
 *
 * @param {{ userId: string, deviceId: string, token: string, baseUrl?: string,
 *   serverIds: string[], _deps?: object }} input
 * @returns {Promise<{ joined: number, skipped: number, reason?: string }>}
 */
export async function joinLinkedDeviceChannels({
  userId,
  deviceId,
  token,
  baseUrl = '',
  serverIds,
  _deps,
}) {
  const mlsGroup = _deps?.mlsGroup ?? mlsGroupLib;
  const mlsStore = _deps?.mlsStore ?? mlsStoreLib;
  const hushCrypto = _deps?.hushCrypto ?? hushCryptoLib;
  const api = _deps?.api ?? apiLib;
  if (!userId || !deviceId || !token || !Array.isArray(serverIds) || serverIds.length === 0) {
    return { joined: 0, skipped: 0, reason: 'nothing_to_join' };
  }
  const db = await mlsStore.openStore(userId, deviceId);
  const credential = await mlsStore.getCredential(db);
  if (!credential) return { joined: 0, skipped: 0, reason: 'no_credential' };
  const deps = { db, token, credential, mlsStore, hushCrypto, api, baseUrl };

  const channelIds = [];
  for (const serverId of serverIds) {
    try {
      const channels = await api.getGuildChannels(token, serverId, baseUrl);
      for (const channel of Array.isArray(channels) ? channels : []) {
        if (channel?.type === 'text' && typeof channel.id === 'string') channelIds.push(channel.id);
      }
    } catch (err) {
      console.warn('[ritualsSpaceLink] could not list channels after link', serverId, err);
    }
  }

  let joined = 0;
  let skipped = 0;
  for (const channelId of channelIds) {
    await withChannelMLSMutex(textChannelKey(channelId), async () => {
      const epoch = await mlsStore.getGroupEpoch(db, channelId);
      if (epoch != null) {
        skipped += 1;
        return;
      }
      await mlsGroup.joinAllChannelGroups(deps, [channelId]);
      joined += 1;
    });
  }
  return { joined, skipped };
}
