/**
 * Verifies PerServerListeners covers an inactive (background)
 * server: it fetches that server's text channels, refcount-
 * subscribes them on the wsClient, and fires onSelfRemoved when
 * the user is the kick target — none of which depended on the
 * server being the active view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

vi.mock("@/lib/api", () => ({
  getGuildChannels: vi.fn().mockResolvedValue([
    { id: "ch-text-1", type: "text" },
    { id: "ch-text-2", type: "text" },
    { id: "ch-voice", type: "voice" },
    { id: "cat", type: "category" },
  ]),
}))

vi.mock("@/lib/mlsGroup", () => ({
  leaveAllChannelGroups: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/mlsStore", () => ({
  openStore: vi.fn().mockResolvedValue({ fake: "db" }),
}))

vi.mock("@/hooks/useAuth", () => ({
  getDeviceId: () => "device-self",
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}))

import { toast } from "sonner"
import { PerServerListeners } from "./PerServerListeners"

interface FakeWs {
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  subscribeChannel: ReturnType<typeof vi.fn>
  unsubscribeChannel: ReturnType<typeof vi.fn>
  emit: (event: string, payload: unknown) => void
}

function makeWs(): FakeWs {
  const handlers = new Map<string, (data: unknown) => void>()
  return {
    on: vi.fn((event: string, h: (d: unknown) => void) => {
      handlers.set(event, h)
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event)
    }),
    subscribeChannel: vi.fn(),
    unsubscribeChannel: vi.fn(),
    emit(event, payload) {
      handlers.get(event)?.(payload)
    },
  }
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe("PerServerListeners", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("subscribes the WS to every text channel of the inactive server it covers", async () => {
    const ws = makeWs()
    render(
      <PerServerListeners
        instanceUrl="https://i.example.com"
        wsClient={ws as unknown as Parameters<typeof PerServerListeners>[0]["wsClient"]}
        token="tok"
        currentUserId="user-self"
        serverId="srv-bg"
        serverName="Background"
        refetchMembers={vi.fn()}
        onSelfRemoved={vi.fn()}
      />,
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(ws.subscribeChannel).toHaveBeenCalledWith("ch-text-1")
      expect(ws.subscribeChannel).toHaveBeenCalledWith("ch-text-2")
    })
    // Voice + category never subscribed.
    expect(ws.subscribeChannel).not.toHaveBeenCalledWith("ch-voice")
    expect(ws.subscribeChannel).not.toHaveBeenCalledWith("cat")
  })

  it("fires onSelfRemoved when the user is the kick target on this background server", async () => {
    const onSelfRemoved = vi.fn()
    const ws = makeWs()
    render(
      <PerServerListeners
        instanceUrl="https://i.example.com"
        wsClient={ws as unknown as Parameters<typeof PerServerListeners>[0]["wsClient"]}
        token="tok"
        currentUserId="user-self"
        serverId="srv-bg"
        serverName="Background"
        refetchMembers={vi.fn()}
        onSelfRemoved={onSelfRemoved}
      />,
      { wrapper: createWrapper() },
    )

    // Wait for the moderation hook to bind its listener.
    await waitFor(() => expect(ws.on).toHaveBeenCalledWith("member_kicked", expect.any(Function)))

    ws.emit("member_kicked", {
      type: "member_kicked",
      server_id: "srv-bg",
      user_id: "user-self",
      reason: "Spam",
    })

    await waitFor(() => {
      expect(onSelfRemoved).toHaveBeenCalledWith({
        instanceUrl: "https://i.example.com",
        serverId: "srv-bg",
        event: "kick",
        reason: "Spam",
      })
    })
  })

  // Rituals fork: the server retires this device's seat when the person opens
  // the Space on a sixth device (reason "device_limit"). The person is still
  // in the Space: calm copy, no raw reason, nothing posted to the Rituals host
  // (so the hub never reads it as a revoke), and the shell still routes away.
  function renderSelf(onSelfRemoved: () => void) {
    const ws = makeWs()
    render(
      <PerServerListeners
        instanceUrl="https://i.example.com"
        wsClient={ws as unknown as Parameters<typeof PerServerListeners>[0]["wsClient"]}
        token="tok"
        currentUserId="user-self"
        serverId="srv-bg"
        serverName="Background"
        refetchMembers={vi.fn()}
        onSelfRemoved={onSelfRemoved}
      />,
      { wrapper: createWrapper() },
    )
    return ws
  }

  it("tells a device retired by the seat cap calmly and posts nothing to the Rituals parent", async () => {
    const parentPost = vi.fn()
    const top = vi.spyOn(window, "top", "get").mockReturnValue({} as Window)
    const parent = vi
      .spyOn(window, "parent", "get")
      .mockReturnValue({ postMessage: parentPost } as unknown as Window)
    try {
      const onSelfRemoved = vi.fn()
      const ws = renderSelf(onSelfRemoved)
      await waitFor(() => expect(ws.on).toHaveBeenCalledWith("member_kicked", expect.any(Function)))

      ws.emit("member_kicked", {
        type: "member_kicked",
        server_id: "srv-bg",
        user_id: "user-self",
        reason: "device_limit",
      })

      await waitFor(() => {
        expect(onSelfRemoved).toHaveBeenCalledWith({
          instanceUrl: "https://i.example.com",
          serverId: "srv-bg",
          event: "kick",
          reason: "device_limit",
        })
      })
      expect(toast).toHaveBeenCalledTimes(1)
      expect(toast).toHaveBeenCalledWith(
        "This device left the space because you opened it on more devices.",
        { description: "Open it again from Rituals to rejoin.", action: undefined },
      )
      expect(toast.error).not.toHaveBeenCalled()
      expect(parentPost).not.toHaveBeenCalled()
    } finally {
      top.mockRestore()
      parent.mockRestore()
    }
  })

  it("offers Open Rituals for a seat-cap retirement in a normal browser tab", async () => {
    const onSelfRemoved = vi.fn()
    const ws = renderSelf(onSelfRemoved)
    await waitFor(() => expect(ws.on).toHaveBeenCalledWith("member_kicked", expect.any(Function)))

    ws.emit("member_kicked", {
      type: "member_kicked",
      server_id: "srv-bg",
      user_id: "user-self",
      reason: "device_limit",
    })

    await waitFor(() => expect(onSelfRemoved).toHaveBeenCalledTimes(1))
    const options = vi.mocked(toast).mock.calls[0]?.[1] as { action?: { label: string } }
    expect(options.action?.label).toBe("Open Rituals")
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("ignores moderation frames addressed to a different server", async () => {
    const onSelfRemoved = vi.fn()
    const refetch = vi.fn()
    const ws = makeWs()
    render(
      <PerServerListeners
        instanceUrl="https://i.example.com"
        wsClient={ws as unknown as Parameters<typeof PerServerListeners>[0]["wsClient"]}
        token="tok"
        currentUserId="user-self"
        serverId="srv-bg"
        refetchMembers={refetch}
        onSelfRemoved={onSelfRemoved}
      />,
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(ws.on).toHaveBeenCalledWith("member_kicked", expect.any(Function)))

    ws.emit("member_kicked", {
      type: "member_kicked",
      server_id: "srv-other",
      user_id: "user-other",
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(onSelfRemoved).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
  })
})
