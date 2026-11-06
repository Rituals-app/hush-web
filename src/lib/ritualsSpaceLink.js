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

/** Set on a device right after a successful Space link; consumed by /space. */
const JUST_LINKED_KEY = 'rituals_space_just_linked';
/** Spaces where a linked device should say earlier messages are elsewhere. */
const EARLIER_ELSEWHERE_KEY = 'rituals_space_earlier_elsewhere';

/**
 * @param {string|null|undefined} origin
 * @returns {boolean} whether `origin` is one of the two Rituals Space origins
 */
export function isRitualsSpaceOrigin(origin) {
  const normalized = normalizeInstanceUrl(origin);
  return Boolean(normalized) && RITUALS_SPACE_ORIGINS.includes(normalized);
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
 * A link is refused when this device already belongs to a Rituals account
 * and the bundle names a different one. With `requireBundleAcct` (the device
 * is on a Rituals Space origin) a bundle that omits `acct` is refused too, so
 * an approver cannot get past the binding by leaving the field out. A device
 * with no marker yet is allowed; it is then not treated as a Space link.
 *
 * @param {string|null|undefined} bundleAcct
 * @param {string|null|undefined} localAcct
 * @param {{ requireBundleAcct?: boolean }} [options]
 * @returns {boolean}
 */
export function isDeviceLinkAccountMismatch(bundleAcct, localAcct, { requireBundleAcct = false } = {}) {
  if (!localAcct) return false;
  if (!bundleAcct) return requireBundleAcct;
  return bundleAcct !== localAcct;
}

/**
 * Whether a completed link is a Space link (marker kept, never-PIN vault,
 * post-link channel join): only on a Rituals Space origin, only when this
 * device already belongs to a Rituals account, and only when the bundle
 * names that same account. Anything else follows the upstream PIN policy.
 *
 * @param {{ bundleAcct?: string|null, localAcct?: string|null, onRitualsOrigin: boolean }} input
 * @returns {boolean}
 */
export function isSpaceDeviceLink({ bundleAcct, localAcct, onRitualsOrigin }) {
  return Boolean(onRitualsOrigin && localAcct && bundleAcct && bundleAcct === localAcct);
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

/** Called by completeDeviceLink after a successful Space link only. */
export function markDeviceJustLinked(now = Date.now()) {
  writeFlag(JUST_LINKED_KEY, String(now));
}

/**
 * Once after a Space link: the link time in ms, then the flag is cleared.
 * @returns {number|null}
 */
export function consumeDeviceJustLinked() {
  const raw = readFlag(JUST_LINKED_KEY);
  if (raw == null) return null;
  writeFlag(JUST_LINKED_KEY, null);
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : null;
}

function readEarlierElsewhere() {
  try {
    const parsed = JSON.parse(readFlag(EARLIER_ELSEWHERE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.at))
      : [];
  } catch {
    return [];
  }
}

/**
 * Records that this device was linked into `serverId` at `linkedAt` while
 * other people already held seats there.
 */
export function markEarlierMessagesElsewhere(serverId, linkedAt) {
  if (typeof serverId !== 'string' || !serverId || !Number.isFinite(linkedAt)) return;
  const entries = readEarlierElsewhere().filter((e) => e.id !== serverId);
  entries.push({ id: serverId, at: linkedAt });
  writeFlag(EARLIER_ELSEWHERE_KEY, JSON.stringify(entries.slice(-200)));
}

/**
 * The link time for `serverId` when a message sent before it should read
 * "Earlier messages are on your other device"; null otherwise. Messages
 * after this time that fail to decrypt keep the ordinary recovery copy.
 *
 * @returns {number|null}
 */
export function earlierMessagesElsewhereBefore(serverId) {
  if (typeof serverId !== 'string' || !serverId) return null;
  return readEarlierElsewhere().find((e) => e.id === serverId)?.at ?? null;
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
