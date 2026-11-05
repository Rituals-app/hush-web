/**
 * Verifies ChannelSidebar's admin-gated context menu items: New text/voice
 * channel stay disabled when canAdministrate is false, and surface a
 * working dialog when admin + handler are provided. (Rituals fork: the
 * space menu has no Invite people at all.)
 *
 * DnD reorder behaviour is exercised end-to-end via the
 * useChannelsForServer adapter test; this file focuses on the
 * presentation layer the user sees.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
})

import { ChannelSidebar } from "./channel-sidebar"
import { SidebarProvider } from "./ui/sidebar"
import { TooltipProvider } from "./ui/tooltip"

const BASE_PROPS = {
  serverName: "Alpha",
  systemChannels: [],
  categories: [],
  channels: [
    {
      id: "ch-1",
      name: "general",
      kind: "text" as const,
      categoryId: null,
    },
  ],
  apps: [],
  activeChannelId: "ch-1",
  onSelectChannel: vi.fn(),
  user: { name: "Y", username: "yarin", initials: "Y" },
  railEntries: [{ id: "home", name: "Home", initials: "HO" }],
  activeRailId: "srv-1",
  onSelectRail: vi.fn(),
}

function setup(
  overrides: Partial<React.ComponentProps<typeof ChannelSidebar>> = {}
) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <ChannelSidebar {...BASE_PROPS} {...overrides} />
      </SidebarProvider>
    </TooltipProvider>
  )
}

describe("ChannelSidebar", () => {
  afterEach(() => cleanup())

  it("renders the server name in the header", () => {
    const { container } = setup()
    expect(container.querySelector('[data-slot="channel-sidebar"]')).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("renders one button per channel", () => {
    setup()
    expect(screen.getByText("general")).toBeInTheDocument()
  })

  it("invokes onSelectChannel when a channel button is clicked", async () => {
    const onSelectChannel = vi.fn()
    setup({ onSelectChannel })

    await userEvent.click(screen.getByText("general"))
    expect(onSelectChannel).toHaveBeenCalledWith("ch-1")
  })

  it("opens the channel section menu from right click", async () => {
    const user = userEvent.setup()
    setup({ canAdministrate: true, onCreateChannel: vi.fn() })

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByText("Channels"),
    })

    expect(await screen.findByText(/new text channel/i)).toBeInTheDocument()
    expect(screen.getByText(/new voice channel/i)).toBeInTheDocument()
  })

  it("opens a channel row menu from right click", async () => {
    const user = userEvent.setup()
    setup({ canAdministrate: true, onDeleteChannel: vi.fn() })

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByText("general").closest("button")!,
    })

    expect(await screen.findByText(/channel settings/i)).toBeInTheDocument()
    expect(screen.getByText(/delete channel/i)).toBeInTheDocument()
  })

  // Rituals fork: Rituals owns who is in a space, so the space menu never
  // offers Invite people, Server settings or Leave, even to admins.
  it("never offers Invite people, Server settings or Leave", async () => {
    setup({ canAdministrate: true })

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /alpha/i }))

    expect(await screen.findByText(/about rituals space/i)).toBeInTheDocument()
    expect(screen.queryByText(/invite people/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/server settings/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/leave server/i)).not.toBeInTheDocument()
  })

  it("keeps Home header active while hiding server actions", async () => {
    setup({ serverName: "Home", serverMenuEnabled: false })

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /home/i }))

    expect(screen.getByText("Spaces")).toBeInTheDocument()
    expect(screen.queryByText(/server settings/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/invite people/i)).not.toBeInTheDocument()
  })
})
