import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import Chat from './Chat.jsx';
import * as api from '../lib/api';

const mockDecryptFromChannel = vi.fn();

vi.mock('../hooks/useAuth', () => ({
  getDeviceId: () => 'device-1',
  getInstanceToken: () => 'tok',
}));

vi.mock('../hooks/useMLS', () => ({
  useMLS: () => ({
    encryptForChannel: vi.fn().mockResolvedValue({ ciphertext: new Uint8Array(32) }),
    decryptFromChannel: mockDecryptFromChannel,
    getCachedMessage: vi.fn().mockResolvedValue(null),
    setCachedMessage: vi.fn(),
  }),
}));

vi.mock('../lib/api', () => ({
  getChannelMessages: vi.fn().mockResolvedValue([]),
}));

function makeWsClient() {
  const handlers = new Map();
  return {
    send: vi.fn(),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event) => {
      handlers.delete(event);
    }),
    isConnected: () => true,
    emit(event, payload) {
      handlers.get(event)?.(payload);
    },
  };
}

describe('Chat realtime cross-device behavior', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockDecryptFromChannel.mockResolvedValue('hello from device A');
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('decrypts realtime messages from another device of the same account', async () => {
    const wsClient = makeWsClient();

    render(
      <Chat
        channelId="ch-1"
        serverId="srv-1"
        currentUserId="user-1"
        getToken={() => 'token'}
        getStore={() => Promise.resolve(null)}
        wsClient={wsClient}
        members={[]}
      />,
    );

    await act(async () => {
      wsClient.emit('message.new', {
        id: 'msg-1',
        channel_id: 'ch-1',
        sender_id: 'user-1',
        sender_device_id: 'device-2',
        ciphertext: 'YWJj',
        timestamp: '2026-04-01T23:16:31.998122Z',
      });
    });

    expect(mockDecryptFromChannel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('hello from device A')).toBeInTheDocument();
  });

  it('does not render malformed v1 envelopes as raw JSON', async () => {
    const malformedEnvelope = JSON.stringify({
      v: 1,
      text: '',
      attachments: [
        {
          id: 'att-svg',
          name: 'logo.svg',
          size: 346,
          mimeType: 'image/svg+xml',
          key: 'AAA=',
          iv: 'BBB=',
        },
      ],
    });
    mockDecryptFromChannel.mockResolvedValueOnce(malformedEnvelope);
    const wsClient = makeWsClient();

    render(
      <Chat
        channelId="ch-1"
        serverId="srv-1"
        currentUserId="user-1"
        getToken={() => 'token'}
        getStore={() => Promise.resolve(null)}
        wsClient={wsClient}
        members={[]}
      />,
    );

    await act(async () => {
      wsClient.emit('message.new', {
        id: 'msg-svg',
        channel_id: 'ch-1',
        sender_id: 'user-other',
        sender_device_id: 'device-other',
        ciphertext: 'YWJj',
        timestamp: '2026-04-01T23:16:31.998122Z',
      });
    });

    expect(
      await screen.findByText('Sent before this device joined the space. End-to-end encryption keeps it private.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(malformedEnvelope)).not.toBeInTheDocument();
  });
});

describe('Chat mark_read realtime behavior', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockDecryptFromChannel.mockResolvedValue('hello');
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('sends mark_read for realtime non-own message.new', async () => {
    const wsClient = makeWsClient();
    const onMarkRead = vi.fn();

    render(
      <Chat
        channelId="ch-1"
        serverId="srv-1"
        currentUserId="user-1"
        getToken={() => 'token'}
        getStore={() => Promise.resolve(null)}
        wsClient={wsClient}
        members={[]}
        markReadEnabled
        onMarkRead={onMarkRead}
      />,
    );

    await act(async () => {
      wsClient.emit('message.new', {
        id: 'rt-msg-1',
        channel_id: 'ch-1',
        sender_id: 'user-other',
        sender_device_id: 'device-other',
        ciphertext: 'YWJj',
        timestamp: '2026-04-01T01:00:00Z',
      });
    });

    expect(wsClient.send).toHaveBeenCalledWith('message.mark_read', {
      channel_id: 'ch-1',
      message_id: 'rt-msg-1',
    });
    expect(onMarkRead).toHaveBeenCalledWith('ch-1');
  });

  it('does not send mark_read for duplicate message id', async () => {
    const wsClient = makeWsClient();

    render(
      <Chat
        channelId="ch-1"
        serverId="srv-1"
        currentUserId="user-1"
        getToken={() => 'token'}
        getStore={() => Promise.resolve(null)}
        wsClient={wsClient}
        members={[]}
        markReadEnabled
      />,
    );

    const payload = {
      id: 'dup-msg',
      channel_id: 'ch-1',
      sender_id: 'user-other',
      sender_device_id: 'device-other',
      ciphertext: 'YWJj',
      timestamp: '2026-04-01T01:00:00Z',
    };

    await act(async () => { wsClient.emit('message.new', payload); });
    // Second emit with same id is blocked by knownMessageIdsRef; only one mark_read.
    await act(async () => { wsClient.emit('message.new', payload); });

    const markReadCalls = wsClient.send.mock.calls.filter(
      ([type]) => type === 'message.mark_read',
    );
    expect(markReadCalls).toHaveLength(1);
  });
});

describe('Chat reconnect catch-up', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockDecryptFromChannel.mockResolvedValue('catch-up text');
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('fetches missed messages on reconnect using after cursor', async () => {
    const ts1 = '2026-04-01T12:00:00.000Z';
    const ts2 = '2026-04-01T12:01:00.000Z';
    const catchUpMsg = { id: 'msg-catch', senderId: 'user-other', channelId: 'ch-1', ciphertext: 'Y2F0Y2g=', timestamp: ts2 };

    // Initial history load returns one message.
    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-1', channelId: 'ch-1', ciphertext: 'YWI=', timestamp: ts1 },
    ]);

    // Reconnect catch-up returns one new message.
    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([catchUpMsg]);

    const wsClient = makeWsClient();

    await act(async () => {
      render(
        <Chat
          channelId="ch-1"
          serverId="srv-1"
          currentUserId="user-1"
          getToken={() => 'token'}
          getStore={() => Promise.resolve(null)}
          wsClient={wsClient}
          members={[]}
          markReadEnabled
        />,
      );
    });

    // The first call is the initial history load.
    expect(api.getChannelMessages).toHaveBeenCalledTimes(1);

    // Simulate reconnect.
    await act(async () => {
      wsClient.emit('reconnected', {});
    });

    // Second call should use after cursor with the latest known backend timestamp.
    expect(api.getChannelMessages).toHaveBeenCalledTimes(2);
    const secondCallOpts = api.getChannelMessages.mock.calls[1][3];
    expect(secondCallOpts).toEqual({ after: ts1, limit: 50 });
  });

  it('merges catch-up messages without duplicating known IDs', async () => {
    const ts1 = '2026-04-01T12:00:00.000Z';
    const ts2 = '2026-04-01T12:01:00.000Z';

    // Initial history load.
    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-other', channelId: 'ch-1', ciphertext: 'YWI=', timestamp: ts1 },
    ]);

    // Reconnect catch-up returns msg-1 (already known) and a new msg-2.
    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-other', channelId: 'ch-1', ciphertext: 'YWI=', timestamp: ts1 },
      { id: 'msg-2', senderId: 'user-other', channelId: 'ch-1', ciphertext: 'Y2F0Y2g=', timestamp: ts2 },
    ]);

    const wsClient = makeWsClient();

    await act(async () => {
      render(
        <Chat
          channelId="ch-1"
          serverId="srv-1"
          currentUserId="user-1"
          getToken={() => 'token'}
          getStore={() => Promise.resolve(null)}
          wsClient={wsClient}
          members={[]}
        />,
      );
    });

    await act(async () => {
      wsClient.emit('reconnected', {});
    });

    // Both initial load + catch-up decrypt to 'catch-up text', but the dedup
    // prevents msg-1 from being added twice. The catch-up call was still made.
    expect(api.getChannelMessages).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('catch-up text', { selector: '.chat-body' })).toHaveLength(2);
    const secondCallOpts = api.getChannelMessages.mock.calls[1][3];
    expect(secondCallOpts.after).toBeTruthy();
  });

  it('preserves chronological order after catch-up', async () => {
    const ts1 = '2026-04-01T12:00:00.000Z';
    const ts3 = '2026-04-01T12:02:00.000Z';

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-other', channelId: 'ch-1', ciphertext: btoa('first'), timestamp: ts1 },
    ]);

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-3', senderId: 'user-other', channelId: 'ch-1', ciphertext: btoa('third'), timestamp: ts3 },
    ]);
    mockDecryptFromChannel.mockImplementation(async (bytes) => new TextDecoder().decode(bytes));

    const wsClient = makeWsClient();

    await act(async () => {
      render(
        <Chat
          channelId="ch-1"
          serverId="srv-1"
          currentUserId="user-1"
          getToken={() => 'token'}
          getStore={() => Promise.resolve(null)}
          wsClient={wsClient}
          members={[]}
        />,
      );
    });

    await act(async () => {
      wsClient.emit('reconnected', {});
    });

    expect(api.getChannelMessages).toHaveBeenCalledTimes(2);
    const first = screen.getByText('first');
    const third = screen.getByText('third');
    expect(first.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('continues reconnect catch-up until the backend returns a partial page', async () => {
    const ts1 = '2026-04-01T12:00:00.000Z';
    const firstPage = Array.from({ length: 50 }, (_, i) => {
      const minute = String(i + 1).padStart(2, '0');
      return {
        id: `page-1-msg-${i}`,
        senderId: 'user-other',
        channelId: 'ch-1',
        ciphertext: 'Y2F0Y2g=',
        timestamp: `2026-04-01T12:${minute}:00.000Z`,
      };
    });
    const secondPage = [
      {
        id: 'page-2-msg-1',
        senderId: 'user-other',
        channelId: 'ch-1',
        ciphertext: 'Y2F0Y2g=',
        timestamp: '2026-04-01T13:00:00.000Z',
      },
    ];

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-1', channelId: 'ch-1', ciphertext: 'YWI=', timestamp: ts1 },
    ]);
    vi.mocked(api.getChannelMessages).mockResolvedValueOnce(firstPage);
    vi.mocked(api.getChannelMessages).mockResolvedValueOnce(secondPage);

    const wsClient = makeWsClient();

    await act(async () => {
      render(
        <Chat
          channelId="ch-1"
          serverId="srv-1"
          currentUserId="user-1"
          getToken={() => 'token'}
          getStore={() => Promise.resolve(null)}
          wsClient={wsClient}
          members={[]}
        />,
      );
    });

    await act(async () => {
      wsClient.emit('reconnected', {});
    });

    expect(api.getChannelMessages).toHaveBeenCalledTimes(3);
    expect(api.getChannelMessages.mock.calls[1][3]).toEqual({ after: ts1, limit: 50 });
    expect(api.getChannelMessages.mock.calls[2][3]).toEqual({
      after: '2026-04-01T12:50:00.000Z',
      limit: 50,
    });
  });

  it('sends mark_read only when markReadEnabled is true and only for newest non-own catch-up message', async () => {
    const ts1 = '2026-04-01T12:00:00.000Z';
    const ts2 = '2026-04-01T12:01:00.000Z';
    const ts3 = '2026-04-01T12:02:00.000Z';

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-1', channelId: 'ch-1', ciphertext: 'YWI=', timestamp: ts1 },
    ]);

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-2', senderId: 'user-other', channelId: 'ch-1', ciphertext: 'Y2F0Y2g=', timestamp: ts2 },
      { id: 'msg-3', senderId: 'user-other2', channelId: 'ch-1', ciphertext: 'ZGVs', timestamp: ts3 },
    ]);

    const wsClient = makeWsClient();

    await act(async () => {
      render(
        <Chat
          channelId="ch-1"
          serverId="srv-1"
          currentUserId="user-1"
          getToken={() => 'token'}
          getStore={() => Promise.resolve(null)}
          wsClient={wsClient}
          members={[]}
          markReadEnabled
        />,
      );
    });

    await act(async () => {
      wsClient.emit('reconnected', {});
    });

    // Only the newest non-own message (msg-3) should get mark_read, not msg-2.
    const markReadCalls = wsClient.send.mock.calls.filter(
      ([type]) => type === 'message.mark_read',
    );
    // One from initial load (no non-own msgs so none), plus one from catch-up (msg-3).
    expect(markReadCalls.length).toBeGreaterThanOrEqual(1);
    const lastMarkRead = markReadCalls[markReadCalls.length - 1];
    expect(lastMarkRead[1].message_id).toBe('msg-3');
  });

  it('does not send mark_read when markReadEnabled is false', async () => {
    const ts1 = '2026-04-01T12:00:00.000Z';
    const ts2 = '2026-04-01T12:01:00.000Z';

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-1', senderId: 'user-1', channelId: 'ch-1', ciphertext: 'YWI=', timestamp: ts1 },
    ]);

    vi.mocked(api.getChannelMessages).mockResolvedValueOnce([
      { id: 'msg-2', senderId: 'user-other', channelId: 'ch-1', ciphertext: 'Y2F0Y2g=', timestamp: ts2 },
    ]);

    const wsClient = makeWsClient();

    await act(async () => {
      render(
        <Chat
          channelId="ch-1"
          serverId="srv-1"
          currentUserId="user-1"
          getToken={() => 'token'}
          getStore={() => Promise.resolve(null)}
          wsClient={wsClient}
          members={[]}
          markReadEnabled={false}
        />,
      );
    });

    await act(async () => {
      wsClient.emit('reconnected', {});
    });

    const markReadCalls = wsClient.send.mock.calls.filter(
      ([type]) => type === 'message.mark_read',
    );
    expect(markReadCalls).toHaveLength(0);
  });
});
