/**
 * WebSocket client for the Go backend. JWT auth (query param or first message),
 * auto-reconnect with exponential backoff, message type routing via event emitter.
 *
 * Reconnect chain:
 *   disconnect detected -> backoff timer -> connect() -> re-auth via token in URL
 *   -> emit('open', { isReconnect: true }) -> onReconnected hook -> app handles
 *   message catch-up and MLS group state recovery -> emit('reconnected', {})
 */

import { recordClientDiagnostic } from './clientDiagnostics.js';
import { parseWsMessage } from './wsSchemas.js';
import { pageInstanceOrigin } from './ritualsSpaceInstance.js';

const DEFAULT_WS_PATH = '/ws';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MULTIPLIER = 2;
const MISSED_PONG_LIMIT = 2;
const STALE_THRESHOLD_MS = 15_000;

/**
 * @param {{ url?: string, getToken: () => string | null, onReconnected?: () => Promise<void> | void }} opts
 *   url: full WS URL (e.g. wss://host/ws) or base URL
 *   getToken: returns the current auth token (refreshed on each reconnect)
 *   onReconnected: optional async hook called after a successful reconnect.
 *     Use this to register MLS group state recovery and message catch-up logic.
 *     The hook is awaited before emitting 'reconnected'. Errors are logged and
 *     do not abort the reconnect.
 * @returns {{
 *   connect: () => void,
 *   disconnect: () => void,
 *   send: (type: string, payload: object) => void,
 *   on: (type: string, callback: (data: object) => void) => void,
 *   off: (type: string, callback: (data: object) => void) => void,
 *   isConnected: () => boolean,
 *   isReconnecting: () => boolean,
 * }}
 */
export function createWsClient(opts) {
  const getToken = opts.getToken;
  const onReconnected = opts.onReconnected ?? null;
  let wsUrl = opts.url;
  if (!wsUrl && typeof location !== 'undefined') {
    const base = pageInstanceOrigin().replace(/^http/, 'ws');
    wsUrl = `${base}${DEFAULT_WS_PATH}`;
  }
  if (!wsUrl) {
    throw new Error('ws url required (or use in browser for default)');
  }

  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  /** @type {Map<string, Set<(data: object) => void>>} */
  const listeners = new Map();
  // Refcount table for channel subscriptions. Multiple owners (active
  // chat in `useChannelMessages`, global text-channel MLS sync hook)
  // can both ask the WS to join the same channel room. Without
  // refcounting, the first owner to call `unsubscribe` would tear
  // the room down for every other owner. Subscribe frame is sent
  // only on the 0 -> 1 transition; unsubscribe frame only on 1 -> 0.
  // On reconnect, every channel with count > 0 is re-subscribed
  // automatically before the `open` event resolves so listeners see
  // the rejoined state.
  /** @type {Map<string, number>} */
  const channelSubscriptions = new Map();
  let authSent = false;
  /**
   * True while a reconnect is scheduled or in progress (between onclose and
   * the completion of the onReconnected hook). The UI can poll isReconnecting()
   * or listen for the 'reconnecting' and 'reconnected' events.
   */
  let reconnecting = false;
  let intentionalClose = false;
  let missedPongs = 0;
  let lastPongTime = Date.now();
  let listenersRegistered = false;

  function emit(type, data) {
    const cbs = listeners.get(type);
    if (cbs) {
      cbs.forEach((cb) => {
        try {
          cb(data);
        } catch (e) {
          console.error('[ws] listener error', type, e);
        }
      });
    }
    const any = listeners.get('*');
    if (any) {
      any.forEach((cb) => {
        try {
          cb({ type, ...data });
        } catch (e) {
          console.error('[ws] listener error *', e);
        }
      });
    }
  }

  function recordInvalidFrame(event, details) {
    recordClientDiagnostic({
      category: 'ws',
      event,
      severity: 'warn',
      details,
    });
  }

  function previewPayload(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnecting = true;
    emit('reconnecting', {});
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempt), RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    intentionalClose = false;
    // readyState 1 === OPEN, 0 === CONNECTING. Avoid global WebSocket reference.
    if (socket && (socket.readyState === 1 || socket.readyState === 0)) return;
    lastPongTime = Date.now();
    // Auth via first WebSocket frame, never the URL query string. Embedding
    // the JWT in the URL would cause it to land in nginx access logs and any
    // referer-style propagation; ans23 closed that path. The server already
    // supports first-message auth (internal/ws/handler.go authFromFirstMessage).
    const ws = new WebSocket(wsUrl);
    socket = ws;
    authSent = false;
    const isReconnect = reconnectAttempt > 0 || reconnecting;

    ws.onopen = async () => {
      reconnectAttempt = 0;

      // Send the auth frame on every connect/reconnect. If no token is
      // available (signed-out tab racing the reconnect), close cleanly so
      // the server tears the upgrade down rather than dangling unauth'd.
      const token = getToken();
      if (token) {
        authSent = true;
        ws.send(JSON.stringify({ type: 'auth', token }));
      } else {
        ws.close();
        return;
      }

      startPing();

      // Replay every refcounted channel subscription before any
      // listener observes `open`. A reconnect drops all server-side
      // room state, so unless we re-emit the frames here, no chat /
      // MLS event for this channel reaches us until something else
      // resubscribes. Listeners that registered via subscribeChannel
      // do not need to know reconnect happened.
      //
      // Ordering invariant: the auth frame above is sent on the same
      // WebSocket, in the same microtask, before these subscribe
      // frames. WebSocket guarantees FIFO delivery on a single
      // connection, and the server reads the first frame as auth
      // (internal/ws/handler.go authFromFirstMessage), so by the time
      // the server processes any subscribe below the connection is
      // already authenticated. Do not insert async work between the
      // auth send and this loop or the invariant breaks silently.
      for (const channelId of channelSubscriptions.keys()) {
        socket.send(JSON.stringify({ type: 'subscribe', channel_id: channelId }));
      }

      emit('open', { isReconnect });

      if (isReconnect) {
        // Run the application-registered recovery hook (message catch-up +
        // MLS group state recovery). Errors are non-fatal - the connection is
        // usable even if recovery partially fails.
        if (onReconnected) {
          try {
            await onReconnected();
          } catch (err) {
            console.error('[ws] onReconnected hook error', err);
          }
        }
        reconnecting = false;
        emit('reconnected', {});
      }
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        recordInvalidFrame('invalid-json-frame', {
          preview: String(event.data ?? ''),
        });
        return;
      }

      const parsed = parseWsMessage(data);
      if (!parsed.ok) {
        recordInvalidFrame('invalid-frame', {
          type: parsed.type,
          reason: parsed.reason,
          issues: parsed.issues,
          preview: previewPayload(data),
        });
        return;
      }

      const type = parsed.data.type;
      if (type === 'pong') {
        missedPongs = 0;
        lastPongTime = Date.now();
        if (pingStart > 0) {
          lastRtt = Math.round(performance.now() - pingStart);
          pingStart = 0;
          emit('rtt', { rtt: lastRtt });
        }
        return;
      }
      emit(type, parsed.data);
    };

    ws.onclose = (event) => {
      socket = null;
      authSent = false;
      stopPing();
      const code = event?.code ?? 0;
      const reason = event?.reason ?? '';
      emit('close', { code, reason });
      // Server-side hard reject due to device revocation. The hub
      // closes the WS with policy-violation (1008) + reason=
      // "device revoked"; reconnect attempts would also be rejected
      // at HTTP upgrade with 401, so do NOT schedule a reconnect.
      // Surface the event so the auth layer can clear the session
      // and the user is forced out of the UI.
      if (code === 1008 && /device revoked/i.test(reason)) {
        intentionalClose = true;
        recordClientDiagnostic({
          category: 'ws',
          event: 'auth-invalid-close',
          severity: 'warn',
          details: {
            code,
            reason,
            authReason: 'device_revoked',
          },
        });
        emit('auth_invalid', { reason: 'device_revoked' });
        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
              detail: { reason: 'device_revoked' },
            }));
          } catch { /* ignore */ }
        }
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      emit('error', {});
    };

    registerNetworkListeners();
  }

  function disconnect() {
    intentionalClose = true;
    removeNetworkListeners();
    stopPing();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    reconnecting = false;
    if (socket) {
      // Detach handlers before closing so onclose doesn't trigger scheduleReconnect.
      const s = socket;
      socket = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      if (s.readyState === 0 /* CONNECTING */) {
        // Calling close() on a CONNECTING socket causes a browser warning.
        // Instead, let it finish opening then immediately close it.
        s.onopen = () => s.close();
      } else {
        s.onopen = null;
        s.close();
      }
    }
    authSent = false;
  }

  function isConnected() {
    // readyState 1 === OPEN. Avoid referencing the global WebSocket to allow
    // environments (tests, SSR) where it may not be defined.
    return socket !== null && socket.readyState === 1;
  }

  function isReconnecting() {
    return reconnecting;
  }

  /** Latest measured round-trip time in milliseconds, or null if unknown. */
  let lastRtt = null;
  let pingTimer = null;
  let pingStart = 0;
  const PING_INTERVAL_MS = 10_000;

  function startPing() {
    stopPing();
    missedPongs = 0;
    pingTimer = setInterval(() => {
      if (!isConnected()) return;
      missedPongs += 1;
      if (missedPongs >= MISSED_PONG_LIMIT) {
        console.warn('[ws] missed', missedPongs, 'pongs - forcing reconnect');
        socket.close();
        return;
      }
      pingStart = performance.now();
      socket.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  }

  // ── Network-aware reconnect ──────────────────────────────────────────────

  function handleOnline() {
    if (intentionalClose) return;
    console.log('[ws] network online - forcing reconnect');
    if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
      socket.close();
      return; // onclose will call scheduleReconnect
    }
    if (!socket && !reconnecting) {
      scheduleReconnect();
    }
  }

  function handleVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible' || intentionalClose) return;
    if (Date.now() - lastPongTime > STALE_THRESHOLD_MS) {
      console.log('[ws] tab visible with stale connection - forcing reconnect');
      if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
        socket.close();
      } else if (!socket && !reconnecting) {
        scheduleReconnect();
      }
    }
  }

  function registerNetworkListeners() {
    if (listenersRegistered) return;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    listenersRegistered = true;
  }

  function removeNetworkListeners() {
    if (!listenersRegistered) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    listenersRegistered = false;
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    lastRtt = null;
  }

  function getRtt() {
    return lastRtt;
  }

  function send(type, payload = {}) {
    if (!isConnected()) return;
    socket.send(JSON.stringify({ type, ...payload }));
  }

  /**
   * Refcounted channel subscribe. Increment the per-channel counter
   * and emit a `subscribe` frame only on the 0 -> 1 transition.
   * Multiple owners can call this safely; only one frame goes on the
   * wire. The reconnect path replays every channel with count > 0,
   * so callers do not need to re-subscribe on `open`.
   *
   * @param {string} channelId
   */
  function subscribeChannel(channelId) {
    if (!channelId) return;
    const prev = channelSubscriptions.get(channelId) ?? 0;
    channelSubscriptions.set(channelId, prev + 1);
    if (prev === 0 && isConnected()) {
      socket.send(JSON.stringify({ type: 'subscribe', channel_id: channelId }));
    }
  }

  /**
   * Refcounted channel unsubscribe. Decrement the per-channel counter
   * and emit an `unsubscribe` frame only on the 1 -> 0 transition.
   * No-op when the channel has no live counter or is already at zero
   * — a defensive guard against double-cleanup paths.
   *
   * @param {string} channelId
   */
  function unsubscribeChannel(channelId) {
    if (!channelId) return;
    const prev = channelSubscriptions.get(channelId) ?? 0;
    if (prev <= 0) return;
    const next = prev - 1;
    if (next === 0) {
      channelSubscriptions.delete(channelId);
      if (isConnected()) {
        socket.send(JSON.stringify({ type: 'unsubscribe', channel_id: channelId }));
      }
    } else {
      channelSubscriptions.set(channelId, next);
    }
  }

  function on(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  }

  function off(type, callback) {
    const cbs = listeners.get(type);
    if (cbs) cbs.delete(callback);
  }

  return {
    connect,
    disconnect,
    send,
    subscribeChannel,
    unsubscribeChannel,
    isConnected,
    isReconnecting,
    getRtt,
    on,
    off,
  };
}
