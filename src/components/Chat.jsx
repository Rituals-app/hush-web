import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Spinner, Flex } from '@radix-ui/themes';
import { PaperPlaneIcon } from '@radix-ui/react-icons';
import { getDeviceId } from '../hooks/useAuth';
import { Textarea } from '@/components/ui/textarea.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Empty, EmptyHeader, EmptyMedia, EmptyDescription } from '@/components/ui/empty';

/** Maximum plaintext byte length before encryption (UTF-8 encoded).
 * Conservative: 4000 bytes < (8192 MLS budget - 16 GCM tag - 80 MLS framing).
 * Accounts for multi-byte UTF-8 characters (CJK, emoji use 3-4 bytes each).
 *
 * Note: this is the *user-visible* plaintext budget. Wire payload now
 * gets a small JSON envelope wrapper (`{"v":1,"text":...}`), so sends
 * close to this ceiling can still fail with ENVELOPE_TOO_LARGE during
 * encrypt. The optimistic row is marked failed in that case.
 */
const MAX_PLAINTEXT_BYTES = 4000;

/** Show byte counter when this fraction of MAX_PLAINTEXT_BYTES is exceeded. */
const COUNTER_SHOW_THRESHOLD = 0.8;
const CHANNEL_MESSAGES_PAGE_LIMIT = 50;
import * as api from '../lib/api';
import { useMLS } from '../hooks/useMLS';
import { formatUserLabel } from '../lib/userLabel';
import {
  encodeEnvelopeV1,
  decodeEnvelopeV1FromString,
  envelopeFromText,
} from '../lib/messageEnvelope';

function base64ToUint8Array(base64) {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

// Module-level pending send cache - survives component unmount/remount so plaintext
// can be recovered when the user navigates back to a channel before the self-echo
// has been processed (or in fan-out mode where no self-echo arrives).
const _pendingSends = new Map();
const PENDING_SEND_TTL = 60_000;

function addPendingSend(channelId, content, senderId) {
  const list = _pendingSends.get(channelId) || [];
  list.push({ content, senderId, timestamp: Date.now() });
  _pendingSends.set(channelId, list);
}

function consumePendingSend(channelId, senderId, serverTimestamp) {
  const list = _pendingSends.get(channelId);
  if (!list?.length) return null;
  const now = Date.now();
  const fresh = list.filter((p) => now - p.timestamp < PENDING_SEND_TTL);
  if (!fresh.length) {
    _pendingSends.delete(channelId);
    return null;
  }
  _pendingSends.set(channelId, fresh);
  const idx = fresh.findIndex(
    (p) => p.senderId === senderId && Math.abs(p.timestamp - serverTimestamp) < 10_000
  );
  if (idx < 0) return null;
  const [match] = fresh.splice(idx, 1);
  if (!fresh.length) _pendingSends.delete(channelId);
  return match.content;
}

/**
 * Decode a wire plaintext into the human-readable text we render. Strict
 * v1 cutover means the wire MUST carry an envelope; anything else is
 * treated as a legacy cache row (older raw plaintext stored before the
 * cutover) and unwrapped as `envelopeFromText`. Returns `{ text, decoded }`
 * where `decoded === false` when the input was not a valid envelope.
 */
function unwrapPlaintext(raw, allowLegacyFallback) {
  const result = decodeEnvelopeV1FromString(raw);
  if (result.ok) return { text: result.envelope.text, decoded: true };
  if (allowLegacyFallback && result.reason === 'non-json') {
    return { text: raw, decoded: true };
  }
  return { text: null, decoded: false };
}

async function decryptMessageRow(m, currentUserId, { decryptFromChannel, getCachedMessage, setCachedMessage }) {
  const ts = new Date(m.timestamp).getTime();
  if (typeof getCachedMessage === 'function') {
    const cached = await getCachedMessage(m.id);
    if (cached) {
      const { text } = unwrapPlaintext(cached.content, true);
      return {
        id: m.id,
        sender: cached.senderId ?? m.senderId,
        content: text,
        timestamp: cached.timestamp,
        decryptionFailed: false,
      };
    }
  }
  if (m.senderId === currentUserId) {
    const pendingContent = consumePendingSend(m.channelId, m.senderId, ts);
    if (pendingContent !== null) {
      if (typeof setCachedMessage === 'function') {
        await setCachedMessage(m.id, { content: pendingContent, senderId: m.senderId, timestamp: ts });
      }
      const { text } = unwrapPlaintext(pendingContent, true);
      return { id: m.id, sender: m.senderId, content: text, timestamp: ts, decryptionFailed: false };
    }
  }
  let content = null;
  let decryptionFailed = false;
  try {
    const ct = base64ToUint8Array(m.ciphertext);
    const wirePlain = await decryptFromChannel(ct);
    const decoded = unwrapPlaintext(wirePlain, true);
    content = decoded.text;
    decryptionFailed = !decoded.decoded;
    if (typeof setCachedMessage === 'function' && decoded.decoded) {
      await setCachedMessage(m.id, { content: wirePlain, senderId: m.senderId, timestamp: ts });
    }
  } catch (err) {
    console.warn('[chat] Decrypt failed for msg', m.id, 'from', m.senderId, err);
    decryptionFailed = true;
  }
  return {
    id: m.id,
    sender: m.senderId,
    content,
    timestamp: ts,
    decryptionFailed,
  };
}

/**
 * Encrypt and send a single-ciphertext MLS message for the channel group.
 * No fan-out - MLS produces one ciphertext for all group members.
 *
 * @param {object} wsClient
 * @param {string} channelId
 * @param {string} plaintext
 * @param {Function} encryptForChannel
 * @returns {Promise<void>}
 */
async function encryptAndSendMLS(wsClient, channelId, plaintext, encryptForChannel) {
  if (!wsClient?.isConnected?.()) {
    throw new Error('Connection lost. Reconnect and retry.');
  }
  // Strict v1 cutover: wrap user plaintext into the JSON envelope so
  // every receiver decodes a known shape. Throws ENVELOPE_TOO_LARGE if
  // the wrapped payload would exceed MAX_ENVELOPE_BYTES.
  const wireBytes = encodeEnvelopeV1(envelopeFromText(plaintext));
  const wireText = new TextDecoder('utf-8').decode(wireBytes);
  const { ciphertext } = await encryptForChannel(wireText);
  if (!wsClient?.isConnected?.()) {
    throw new Error('Connection lost. Reconnect and retry.');
  }
  wsClient.send('message.send', {
    channel_id: channelId,
    ciphertext: uint8ArrayToBase64(ciphertext),
  });
}


export default function Chat({
  channelId,
  serverId,
  currentUserId,
  getToken,
  getStore,
  getHistoryStore,
  wsClient: wsClientProp,
  members = [],
  onNewMessage,
  markReadEnabled = false,
  onMarkRead = null,
  baseUrl = '',
}) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [inputByteLength, setInputByteLength] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [loadMoreLoading, setLoadMoreLoading] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const messagesEndRef = useRef(null);
  const messagesScrollRef = useRef(null);
  const inputRef = useRef(null);
  const lastSentTempIdRef = useRef(null);
  const knownMessageIdsRef = useRef(new Set());
  const wsClientRef = useRef(wsClientProp);
  wsClientRef.current = wsClientProp;
  const scrollRestoreRef = useRef(null);
  const lastAckedIdRef = useRef(null);
  const latestBackendTsRef = useRef(null);
  const markReadEnabledRef = useRef(markReadEnabled);
  const onMarkReadRef = useRef(onMarkRead);
  markReadEnabledRef.current = markReadEnabled;
  onMarkReadRef.current = onMarkRead;

  const displayNameMap = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      const uid = m.userId ?? m.id;
      const label = formatUserLabel({
        displayName: m.displayName,
        username: m.username,
        fallback: '',
      });
      if (uid && label) map.set(uid, label);
    }
    return map;
  }, [members]);

  const { encryptForChannel, decryptFromChannel, getCachedMessage, setCachedMessage } = useMLS({
    getStore: getStore ?? (() => Promise.resolve(null)),
    getHistoryStore: getHistoryStore ?? (() => Promise.resolve(null)),
    getToken: getToken ?? (() => null),
    channelId,
    baseUrl,
  });

  const decryptFromChannelRef = useRef(decryptFromChannel);
  decryptFromChannelRef.current = decryptFromChannel;
  const encryptForChannelRef = useRef(encryptForChannel);
  encryptForChannelRef.current = encryptForChannel;
  const getCachedMessageRef = useRef(getCachedMessage);
  getCachedMessageRef.current = getCachedMessage;
  const setCachedMessageRef = useRef(setCachedMessage);
  setCachedMessageRef.current = setCachedMessage;
  const wsClient = wsClientProp;

  // Track which channel the current messages belong to, so we can detect
  // stale messages during render without clearing them (avoids empty-flash).
  const loadedChannelRef = useRef(channelId);

  // Load history and subscribe to channel
  useEffect(() => {
    if (!channelId || !serverId || !getToken) return;
    const token = getToken();
    if (!token) return;

    // Reset refs immediately (sync, no re-render)
    knownMessageIdsRef.current = new Set();
    lastSentTempIdRef.current = null;
    scrollRestoreRef.current = null;
    lastAckedIdRef.current = null;
    latestBackendTsRef.current = null;

    const loadHistory = async () => {
      try {
        const list = await api.getChannelMessages(token, serverId, channelId, { limit: CHANNEL_MESSAGES_PAGE_LIMIT }, baseUrl);
        const decrypted = [];
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i];
          decrypted.push(
            await decryptMessageRow(m, currentUserId, {
              decryptFromChannel: decryptFromChannelRef.current,
              getCachedMessage: getCachedMessageRef.current,
              setCachedMessage: setCachedMessageRef.current,
            })
          );
          knownMessageIdsRef.current.add(m.id);
        }
        // Atomic replacement: old messages → new messages in one render
        loadedChannelRef.current = channelId;
        setMessages(decrypted);
        setHasMoreOlder(list.length >= CHANNEL_MESSAGES_PAGE_LIMIT);
        if (decrypted.length > 0) {
          latestBackendTsRef.current = decrypted[decrypted.length - 1].timestamp;
        }
        setInputText('');
        // Acknowledge newest visible non-own message to advance the read marker.
        if (markReadEnabledRef.current && wsClientRef.current?.isConnected()) {
          for (let i = decrypted.length - 1; i >= 0; i--) {
            const m = decrypted[i];
            if (m.sender !== currentUserId && m.id && !m.pending) {
              if (lastAckedIdRef.current !== m.id) {
                lastAckedIdRef.current = m.id;
                wsClientRef.current.send('message.mark_read', { channel_id: channelId, message_id: m.id });
                onMarkReadRef.current?.(channelId);
              }
              break;
            }
          }
        }
      } catch (err) {
        console.error('[chat] Load history failed:', err.message);
        loadedChannelRef.current = channelId;
        setMessages([]);
      } finally {
        setIsInitialLoading(false);
      }
    };
    loadHistory();
  }, [channelId, serverId, getToken, currentUserId]);

  const loadMore = useCallback(async () => {
    if (!channelId || !serverId || !getToken || loadMoreLoading || !hasMoreOlder || messages.length === 0) return;
    const token = getToken();
    if (!token) return;
    const oldestTs = messages[0]?.timestamp;
    if (!oldestTs) return;
    setLoadMoreLoading(true);
    try {
      const before = new Date(oldestTs).toISOString();
      const list = await api.getChannelMessages(token, serverId, channelId, { before, limit: CHANNEL_MESSAGES_PAGE_LIMIT }, baseUrl);
      if (list.length === 0) {
        setHasMoreOlder(false);
        return;
      }
      if (list.length < CHANNEL_MESSAGES_PAGE_LIMIT) setHasMoreOlder(false);
      const older = [];
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (knownMessageIdsRef.current.has(m.id)) continue;
        knownMessageIdsRef.current.add(m.id);
        older.push(
          await decryptMessageRow(m, currentUserId, {
            decryptFromChannel: decryptFromChannelRef.current,
            getCachedMessage: getCachedMessageRef.current,
            setCachedMessage: setCachedMessageRef.current,
          })
        );
      }
      const el = messagesScrollRef.current;
      const oldScrollHeight = el?.scrollHeight ?? 0;
      const oldScrollTop = el?.scrollTop ?? 0;
      scrollRestoreRef.current = { oldScrollHeight, oldScrollTop };
      setMessages((prev) => [...older, ...prev]);
    } catch (err) {
      console.error('[chat] Load more failed:', err.message);
    } finally {
      setLoadMoreLoading(false);
    }
  }, [channelId, serverId, getToken, messages, loadMoreLoading, hasMoreOlder, currentUserId]);

  const handleScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el || loadMoreLoading || !hasMoreOlder) return;
    if (el.scrollTop < 80) loadMore();
  }, [loadMore, loadMoreLoading, hasMoreOlder]);

  // Subscribe to channel and listen for message.new
  useEffect(() => {
    if (!wsClient || !channelId) return;

    function doSubscribe() {
      if (wsClient.isConnected()) wsClient.send('subscribe', { channel_id: channelId });
    }
    doSubscribe();
    wsClient.on('open', doSubscribe);

    const onMessageNew = async (data) => {
      if (data.channel_id !== channelId) return;
      const id = data.id || `msg-${Date.now()}`;
      if (knownMessageIdsRef.current.has(id)) return;
      knownMessageIdsRef.current.add(id);
      const senderId = data.sender_id;
      const ts = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();

      // Track the latest backend timestamp for reconnect catch-up.
      if (data.id && ts > (latestBackendTsRef.current ?? 0)) {
        latestBackendTsRef.current = ts;
      }

      const isOwnLocalEcho = senderId === currentUserId && data.sender_device_id === getDeviceId();
      if (isOwnLocalEcho) {
        const pendingContent = consumePendingSend(data.channel_id, currentUserId, ts);
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.pending && m.sender === currentUserId);
          if (idx < 0) return prev;
          return prev.map((m, i) => (i === idx ? { ...m, id, pending: false, failed: false, timestamp: ts } : m));
        });
        if (pendingContent !== null) {
          setCachedMessageRef.current?.(id, { content: pendingContent, senderId: currentUserId, timestamp: ts });
        }
        return;
      }

      let content = null;
      let decryptionFailed = false;
      // MLS: single ciphertext for all group members. No ciphertext_by_recipient.
      const ciphertext = data.ciphertext;
      if (ciphertext) {
        try {
          const ct = base64ToUint8Array(ciphertext);
          const wirePlain = await decryptFromChannelRef.current(ct);
          const decoded = unwrapPlaintext(wirePlain, true);
          content = decoded.text;
          decryptionFailed = !decoded.decoded;
          if (setCachedMessageRef.current && decoded.decoded) {
            setCachedMessageRef.current(id, { content: wirePlain, senderId, timestamp: ts });
          }
        } catch (err) {
          console.warn('[chat] realtime decrypt failed', {
            channelId: data.channel_id,
            messageId: id,
            senderId,
            err: err?.message ?? String(err),
          });
          decryptionFailed = true;
        }
      }
      const msg = {
        id,
        sender: senderId,
        content,
        timestamp: ts,
        decryptionFailed,
      };
      onNewMessage?.();
      setMessages((prev) => [...prev, msg]);
      // Acknowledge non-own messages with a concrete backend ID.
      if (markReadEnabledRef.current && data.id && senderId !== currentUserId &&
          wsClientRef.current?.isConnected() && lastAckedIdRef.current !== id) {
        lastAckedIdRef.current = id;
        wsClientRef.current.send('message.mark_read', { channel_id: channelId, message_id: id });
        onMarkReadRef.current?.(channelId);
      }
    };
    const onError = (data) => {
      if (data.code === 'forbidden' || data.code === 'internal') {
        setMessages((prev) => prev.map((m) => (m.pending ? { ...m, pending: false, failed: true } : m)));
      }
    };
    wsClient.on('message.new', onMessageNew);
    wsClient.on('error', onError);
    return () => {
      wsClient.off('open', doSubscribe);
      wsClient.off('message.new', onMessageNew);
      wsClient.off('error', onError);
      if (wsClient.isConnected()) wsClient.send('unsubscribe', { channel_id: channelId });
    };
  }, [wsClient, channelId, currentUserId, onNewMessage]);

  // Reconnect catch-up: fetch missed messages using the after cursor.
  useEffect(() => {
    if (!wsClient || !channelId || !serverId || !getToken) return;

    const onReconnected = async () => {
      const latestTs = latestBackendTsRef.current;
      if (latestTs == null) return;
      const token = getToken?.();
      if (!token) return;
      try {
        let newestNonOwnId = null;
        let newestNonOwnTs = 0;
        const appended = [];
        let cursorTs = latestTs;

        for (;;) {
          const after = new Date(cursorTs).toISOString();
          const list = await api.getChannelMessages(
            token,
            serverId,
            channelId,
            { after, limit: CHANNEL_MESSAGES_PAGE_LIMIT },
            baseUrl
          );
          if (list.length === 0) break;

          let nextCursorTs = cursorTs;
          for (const m of list) {
            const ts = new Date(m.timestamp).getTime();
            if (ts > nextCursorTs) nextCursorTs = ts;
            if (knownMessageIdsRef.current.has(m.id)) continue;
            knownMessageIdsRef.current.add(m.id);
            const decrypted = await decryptMessageRow(m, currentUserId, {
              decryptFromChannel: decryptFromChannelRef.current,
              getCachedMessage: getCachedMessageRef.current,
              setCachedMessage: setCachedMessageRef.current,
            });
            appended.push(decrypted);
            if (m.senderId !== currentUserId && m.id && ts > newestNonOwnTs) {
              newestNonOwnId = m.id;
              newestNonOwnTs = ts;
            }
          }

          if (nextCursorTs <= cursorTs || list.length < CHANNEL_MESSAGES_PAGE_LIMIT) break;
          cursorTs = nextCursorTs;
        }
        if (appended.length === 0) return;
        setMessages((prev) => {
          const merged = [...prev, ...appended];
          merged.sort((a, b) => a.timestamp - b.timestamp);
          return merged;
        });
        if (appended[appended.length - 1].timestamp > latestTs) {
          latestBackendTsRef.current = appended[appended.length - 1].timestamp;
        }
        if (markReadEnabledRef.current && newestNonOwnId && wsClientRef.current?.isConnected() &&
            lastAckedIdRef.current !== newestNonOwnId) {
          lastAckedIdRef.current = newestNonOwnId;
          wsClientRef.current.send('message.mark_read', { channel_id: channelId, message_id: newestNonOwnId });
          onMarkReadRef.current?.(channelId);
        }
      } catch (err) {
        console.error('[chat] Reconnect catch-up failed:', err.message);
      }
    };

    wsClient.on('reconnected', onReconnected);
    return () => {
      wsClient.off('reconnected', onReconnected);
    };
  }, [wsClient, channelId, serverId, getToken, currentUserId, baseUrl]);

  useEffect(() => {
    const rest = scrollRestoreRef.current;
    if (rest) {
      scrollRestoreRef.current = null;
      const el = messagesScrollRef.current;
      if (el && rest.oldScrollHeight > 0) {
        const newScrollHeight = el.scrollHeight;
        el.scrollTop = newScrollHeight - rest.oldScrollHeight + rest.oldScrollTop;
      }
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isSending || !channelId || !wsClient) return;
    if (new TextEncoder().encode(trimmed).byteLength > MAX_PLAINTEXT_BYTES) return;
    const token = getToken?.();
    if (!token) return;

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage = {
      id: tempId,
      sender: currentUserId,
      content: trimmed,
      timestamp: Date.now(),
      decryptionFailed: false,
      pending: true,
      failed: false,
    };
    setMessages((prev) => [...prev, optimisticMessage]);
    setInputText('');
    inputRef.current?.focus();
    lastSentTempIdRef.current = tempId;
    setIsSending(true);
    addPendingSend(channelId, trimmed, currentUserId);

    try {
      await encryptAndSendMLS(wsClient, channelId, trimmed, encryptForChannelRef.current);
    } catch (err) {
      console.error('[chat] Send failed:', err?.message ?? err);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
    } finally {
      lastSentTempIdRef.current = null;
      setIsSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const handleRetry = async (msg) => {
    if (!channelId || !wsClient || msg.failed !== true) return;
    const trimmed = (msg.content || '').trim();
    if (!trimmed) return;
    const tempId = msg.id;
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, failed: false, pending: true } : m)));
    try {
      await encryptAndSendMLS(wsClient, channelId, trimmed, encryptForChannelRef.current);
    } catch (err) {
      console.error('[chat] Retry send failed:', err.message);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  // While fetching a new channel's messages, hide stale content from the
  // previous channel so the user never sees the wrong messages.
  const isChannelTransitioning = loadedChannelRef.current !== channelId;
  const visibleMessages = isChannelTransitioning ? [] : messages;
  const hasMessages = visibleMessages.length > 0;

  // Precompute per-row display values so toDateKey/formatDateLabel/formatTime
  // are not called multiple times per row on every render (HUSHHQ-115).
  const visibleRows = useMemo(
    () =>
      visibleMessages.map((msg, idx) => {
        const prevMsg = idx > 0 ? visibleMessages[idx - 1] : null;
        const dateKey = toDateKey(msg.timestamp);
        const showDateSep = prevMsg ? dateKey !== toDateKey(prevMsg.timestamp) : true;
        const timeLabel = formatTime(msg.timestamp);
        const dateLabel = showDateSep ? formatDateLabel(msg.timestamp) : null;
        return { msg, prevMsg, dateKey, showDateSep, timeLabel, dateLabel };
      }),
    [visibleMessages]
  );

  return (
    <div className="chat-container">
      <div className="chat-messages-section">
        <div
          ref={messagesScrollRef}
          onScroll={handleScroll}
          className="chat-messages-scroll"
          aria-busy={isChannelTransitioning || isInitialLoading}
        >
          {/* Spacer: grows to push messages to the bottom when they don't fill the container.
              Must come BEFORE messages; justify-content: flex-end is not usable here because
              it makes top-overflow unreachable (negative scrollTop territory). */}
          <div className="chat-messages-spacer" />
          {!isChannelTransitioning && hasMoreOlder && (loadMoreLoading || visibleMessages.length > 0) && (
            <div className="chat-load-more-hint">
              {loadMoreLoading ? (
                <Flex align="center" justify="center" gap="2">
                  <Spinner size="1" />
                </Flex>
              ) : (
                'Scroll up for older messages'
              )}
            </div>
          )}
          {isChannelTransitioning || isInitialLoading ? (
            <Flex
              className="chat-empty chat-empty--loading"
              flexGrow="1"
              align="center"
              justify="center"
              minHeight="100%"
            >
              <Spinner size="3" />
            </Flex>
          ) : !hasMessages ? (
            <Empty className="chat-empty">
              <EmptyHeader>
                <EmptyMedia className="chat-empty-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" focusable="false">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </EmptyMedia>
                <EmptyDescription className="chat-empty-text">
                  no messages yet, start the conversation
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            visibleRows.map(({ msg, prevMsg, showDateSep, timeLabel, dateLabel }) => {
              const isOwn = msg.sender === currentUserId;
              const isFailed = msg.failed === true;
              const isPending = msg.pending === true;
              const consecutive = isConsecutive(prevMsg, msg);
              const displayName = isOwn ? 'You' : (displayNameMap.get(msg.sender) ?? truncateUserId(msg.sender));

              return (
                <div key={msg.id}>
                  {showDateSep && (
                    <div className="date-separator">
                      <span className="date-separator-label">{dateLabel}</span>
                    </div>
                  )}
                  <div
                    className={[
                      'chat-message-row',
                      consecutive ? 'message-consecutive' : '',
                      isOwn ? 'chat-message-row--own' : '',
                      isFailed ? 'chat-message-row--failed' : '',
                      isPending ? 'chat-message-row--pending' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {!consecutive && (
                      <div className="chat-message-header">
                        <span className={`chat-username${isOwn ? ' chat-username--own' : ''}`}>
                          {displayName}
                        </span>
                        <span className="chat-timestamp message-timestamp">{timeLabel}</span>
                      </div>
                    )}
                    {consecutive && (
                      <span className="chat-timestamp message-timestamp">{timeLabel}</span>
                    )}
                    <div className="chat-body">
                      {msg.decryptionFailed ? (
                        <span className="chat-decryption-failed">
                          Sent before this device joined the space. End-to-end encryption keeps it private.
                        </span>
                      ) : (
                        msg.content
                      )}
                    </div>
                    {isPending && (
                      <div className="chat-pending-indicator">sending…</div>
                    )}
                    {isFailed && (
                      <div className="chat-retry-wrapper">
                        <Button
                          type="button"
                          variant="ghost"
                          className="chat-retry-btn"
                          onClick={() => handleRetry(msg)}
                        >
                          Retry
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {hasMessages && <div ref={messagesEndRef} />}
        </div>
      </div>
      <div className="chat-input-bar">
        <div className="chat-input-wrapper">
          <Textarea
            id="chat-message"
            name="message"
            ref={inputRef}
            className="chat-input"
            aria-label="Message"
            value={inputText}
            onChange={(e) => {
              const text = e.target.value;
              setInputText(text);
              setInputByteLength(new TextEncoder().encode(text).byteLength);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            rows={1}
            disabled={isSending}
            autoComplete="off"
          />
          {inputByteLength >= MAX_PLAINTEXT_BYTES * COUNTER_SHOW_THRESHOLD && (
            <span
              className={`chat-byte-counter${inputByteLength > MAX_PLAINTEXT_BYTES ? ' chat-byte-counter--over' : ''}`}
              aria-live="polite"
            >
              {MAX_PLAINTEXT_BYTES - inputByteLength}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            className={`chat-send-btn${!inputText.trim() || isSending || inputByteLength > MAX_PLAINTEXT_BYTES ? ' chat-send-btn--disabled' : ''}`}
            onClick={handleSend}
            disabled={!inputText.trim() || isSending || inputByteLength > MAX_PLAINTEXT_BYTES}
            aria-label="Send message"
          >
            <PaperPlaneIcon
              data-icon="inline-start"
              width="16"
              height="16"
              aria-hidden="true"
              style={{ transform: 'rotate(-45deg)' }}
            />
          </Button>
        </div>
      </div>
    </div>
  );
}

function truncateUserId(userId) {
  if (!userId) return 'User';
  return userId.slice(0, 8) + '…';
}

/**
 * Returns true when two messages are from the same sender and less than 5
 * minutes apart, qualifying the second for "consecutive" (collapsed) display.
 *
 * @param {object} prev - Previous message object
 * @param {object} curr - Current message object
 * @returns {boolean}
 */
function isConsecutive(prev, curr) {
  if (!prev || !curr) return false;
  if (prev.sender !== curr.sender) return false;
  if (prev.pending || curr.pending) return false;
  return Math.abs(curr.timestamp - prev.timestamp) < 5 * 60 * 1000;
}

/**
 * Returns a locale date string (YYYY-MM-DD) for a timestamp, used to
 * detect day boundaries between messages.
 *
 * @param {number} timestamp - Unix ms timestamp
 * @returns {string}
 */
function toDateKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Formats a timestamp as a human-readable date label for separators.
 *
 * @param {number} timestamp - Unix ms timestamp
 * @returns {string}
 */
function formatDateLabel(timestamp) {
  const d = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (toDateKey(d.getTime()) === toDateKey(today.getTime())) return 'Today';
  if (toDateKey(d.getTime()) === toDateKey(yesterday.getTime())) return 'Yesterday';

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
