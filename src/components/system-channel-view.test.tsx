/**
 * Verifies SystemChannelView header, loading skeleton, error banner,
 * empty state, and event row rendering for both server-log and
 * moderation sources.
 */
import * as React from "react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("@/adapters/useSystemEvents", () => ({
  useSystemEvents: vi.fn(),
}))

import { useSystemEvents } from "@/adapters/useSystemEvents"
import {
  SystemChannelView,
  SYSTEM_CHANNEL_HEADERS,
} from "./system-channel-view"
import { SidebarProvider } from "@/components/ui/sidebar"

const mockHook = vi.mocked(useSystemEvents)

// SystemChannelView mounts a SidebarTrigger so the user can reopen the
// channel-list sidebar from a system channel on a narrow window. The
// trigger reads the SidebarProvider context, so every test render
// needs the provider — wrap once here.
function renderWithShell(ui: React.ReactElement) {
  return render(<SidebarProvider>{ui}</SidebarProvider>)
}

describe("SystemChannelView", () => {
  afterEach(() => {
    cleanup()
    mockHook.mockReset()
  })

  // The system view no longer renders its own header — ChannelView
  // wraps it and supplies the icon/title/topic from
  // SYSTEM_CHANNEL_HEADERS. Keep the per-source metadata covered here
  // so a regression on the lookup table fails loudly.
  it("exposes header metadata for the server-log source", () => {
    expect(SYSTEM_CHANNEL_HEADERS["server-log"].title).toBe("System log")
    expect(SYSTEM_CHANNEL_HEADERS["server-log"].topic).toMatch(
      /automatic record of server-wide events/i
    )
  })

  it("exposes header metadata for the moderation source", () => {
    expect(SYSTEM_CHANNEL_HEADERS.moderation.title).toBe("Moderation")
    expect(SYSTEM_CHANNEL_HEADERS.moderation.topic).toMatch(
      /audit log of moderator actions/i
    )
  })

  it("shows the empty state when no events are present", () => {
    mockHook.mockReturnValue({
      events: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderWithShell(
      <SystemChannelView
        serverId="g1"
        source="server-log"
        token="tok"
        baseUrl=""
      />
    )

    expect(screen.getByText(/no events yet/i)).toBeInTheDocument()
  })

  it("renders an error banner when fetch fails", () => {
    mockHook.mockReturnValue({
      events: [],
      loading: false,
      error: new Error("backend down"),
      refetch: vi.fn(),
    })

    renderWithShell(
      <SystemChannelView
        serverId="g1"
        source="server-log"
        token="tok"
        baseUrl=""
      />
    )

    expect(screen.getByText(/failed to load events/i)).toBeInTheDocument()
  })

  it("renders one row per event with humanised type and shortened ids", () => {
    mockHook.mockReturnValue({
      events: [
        {
          id: "e1",
          eventType: "channel.created",
          actorId: "abcdef1234567890",
          targetId: "1234567890abcdef",
          reason: "spam wave",
          createdAt: "2026-05-04T12:00:00Z",
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderWithShell(
      <SystemChannelView
        serverId="g1"
        source="server-log"
        token="tok"
        baseUrl=""
      />
    )

    expect(screen.getByText("Channel Created")).toBeInTheDocument()
    expect(screen.getByText(/abcd…7890/)).toBeInTheDocument()
    expect(screen.getByText(/spam wave/i)).toBeInTheDocument()
  })

  it("shows a later device of a person as one quiet line", () => {
    mockHook.mockReturnValue({
      events: [
        {
          id: "e2",
          eventType: "member_new_device",
          actorId: "device-two",
          createdAt: "2026-11-05T12:00:00Z",
        },
        {
          id: "e3",
          eventType: "member_joined",
          actorId: "carol-one",
          createdAt: "2026-11-05T12:01:00Z",
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderWithShell(
      <SystemChannelView
        serverId="g1"
        source="server-log"
        token="tok"
        baseUrl=""
        resolveActorLabel={(id) => (id === "device-two" ? "Alice" : "Carol")}
      />
    )

    expect(
      screen.getByText("Alice opened this space on a new device.")
    ).toBeInTheDocument()
    expect(screen.queryByText("Member New Device")).toBeNull()
    // A first seat keeps today's row.
    expect(screen.getByText("Member Joined")).toBeInTheDocument()
    expect(screen.getAllByText(/Actor:/)).toHaveLength(1)
  })
})
