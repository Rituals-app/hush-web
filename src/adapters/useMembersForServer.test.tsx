/**
 * Verifies useMembersForServer fetches via api.getGuildMembers and maps
 * the response to ServerMember[] with permissionLevel→role conversion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

vi.mock("@/lib/api", () => ({
  getGuildMembers: vi.fn(),
}))

import { getGuildMembers as _getGuildMembers } from "@/lib/api"
import {
  membersForServerQueryKey,
  useMembersForServer,
} from "./useMembersForServer"

const getGuildMembers = vi.mocked(
  _getGuildMembers as (
    token: string,
    serverId: string,
    baseUrl?: string
  ) => Promise<unknown>
)

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

describe("useMembersForServer", () => {
  beforeEach(() => {
    getGuildMembers.mockReset()
  })

  it("maps backend permission levels to roles", async () => {
    getGuildMembers.mockResolvedValue([
      { id: "u1", username: "alice", permissionLevel: 0 },
      { id: "u2", username: "bob", permissionLevel: 1 },
      { id: "u3", username: "carol", permissionLevel: 2 },
      { id: "u4", username: "dan", permissionLevel: 3 },
    ])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u1",
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.current.members).toHaveLength(4)
    })
    expect(result.current.members.map((m) => m.role)).toEqual([
      "member",
      "moderator",
      "admin",
      "owner",
    ])
  })

  it("returns an empty list when serverId is null", async () => {
    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: null,
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u1",
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.current.members).toEqual([])
    })
    expect(getGuildMembers).not.toHaveBeenCalled()
  })

  it("captures fetch errors without throwing", async () => {
    getGuildMembers.mockRejectedValue(new Error("network down"))

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u1",
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.current.error).not.toBeNull()
    })
    expect(result.current.members).toEqual([])
  })

  it("derives initials and uses displayName when present", async () => {
    getGuildMembers.mockResolvedValue([
      { id: "u1", displayName: "Yarin Cardillo", permissionLevel: 0 },
    ])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u1",
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.current.members).toHaveLength(1)
    })
    expect(result.current.members[0].name).toBe("Yarin Cardillo")
    expect(result.current.members[0].initials).toBe("YC")
  })

  it("uses undecorated username as the visible label when displayName is absent", async () => {
    getGuildMembers.mockResolvedValue([
      { id: "u1", username: "@mike", displayName: "", permissionLevel: 0 },
    ])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u1",
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.current.members).toHaveLength(1)
    })
    expect(result.current.members[0].name).toBe("mike")
    expect(result.current.members[0].initials).toBe("M")
  })

  // Presence readiness contract — without this gate, the initial
  // empty `onlineUserIds` set would render every member offline
  // until the first `presence.update` frame arrived.
  it("renders rows online when presence snapshot has not arrived yet", async () => {
    getGuildMembers.mockResolvedValue([
      { id: "u1", username: "alice", permissionLevel: 0 },
      { id: "u2", username: "bob", permissionLevel: 0 },
    ])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u-self",
          onlineUserIds: new Set(),
          hasOnlineSnapshot: false,
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.members).toHaveLength(2))
    expect(result.current.members.map((m) => m.presence)).toEqual([
      "online",
      "online",
    ])
  })

  it("derives presence from onlineUserIds once a snapshot has arrived", async () => {
    getGuildMembers.mockResolvedValue([
      { id: "u1", username: "alice", permissionLevel: 0 },
      { id: "u2", username: "bob", permissionLevel: 0 },
    ])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u-self",
          onlineUserIds: new Set(["u1"]),
          hasOnlineSnapshot: true,
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.members).toHaveLength(2))
    expect(result.current.members.find((m) => m.id === "u1")?.presence).toBe(
      "online",
    )
    expect(result.current.members.find((m) => m.id === "u2")?.presence).toBe(
      "offline",
    )
  })

  it("shows every device of one person (same personKey) as that person", async () => {
    getGuildMembers.mockResolvedValue([
      { id: "a2", username: "alice-4821", displayName: "Alice", personKey: "pk-a", joinedAt: "2026-11-05T10:00:00Z" },
      { id: "a1", username: "alice-1203", displayName: "Alice M", personKey: "pk-a", joinedAt: "2026-11-01T10:00:00Z" },
      { id: "b1", username: "bob", displayName: "Bob", permissionLevel: 0 },
    ])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "b1",
          onlineUserIds: new Set(["a2"]),
          hasOnlineSnapshot: true,
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.members).toHaveLength(3))
    const [a2, a1, b1] = result.current.members
    // The latest-joined device names the person; no per-device handle; online if any device is.
    expect([a2.name, a1.name]).toEqual(["Alice", "Alice"])
    expect([a2.username, a1.username]).toEqual([null, null])
    expect([a2.presence, a1.presence]).toEqual(["online", "online"])
    expect(a1.personKey).toBe("pk-a")
    // A member with no key is unchanged.
    expect(b1).toMatchObject({ name: "Bob", username: "bob", presence: "offline" })
    expect(b1.personKey).toBeUndefined()
  })

  it("refetches through the server-state query", async () => {
    getGuildMembers
      .mockResolvedValueOnce([{ id: "u1", username: "alice", permissionLevel: 0 }])
      .mockResolvedValueOnce([{ id: "u2", username: "bob", permissionLevel: 0 }])

    const { result } = renderHook(
      () =>
        useMembersForServer({
          serverId: "g1",
          token: "tok",
          baseUrl: "https://a.example.com",
          currentUserId: "u-self",
        }),
      { wrapper: createWrapper() },
    )

    await waitFor(() => expect(result.current.members[0]?.id).toBe("u1"))
    await result.current.refetch()
    await waitFor(() => expect(result.current.members[0]?.id).toBe("u2"))
    expect(getGuildMembers).toHaveBeenCalledTimes(2)
  })

  it("exposes a stable query key for member cache invalidation", () => {
    expect(
      membersForServerQueryKey({
        serverId: "g1",
        baseUrl: "https://a.example.com",
        currentUserId: "u-self",
      }),
    ).toEqual([
      "servers",
      "https://a.example.com",
      "g1",
      "members",
      "u-self",
    ])
  })
})
