/**
 * Behaviour port from src/components/ServerList.test.jsx + GuildContextMenu.
 * Rituals fork: the rail's right-click menu no longer surfaces Leave or
 * Delete server (Rituals owns a space's lifecycle); see the test below.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

beforeAll(() => {
  // ResizeObserver is required by server-rail's edge-fade scroll observer.
  // jsdom does not implement it, so provide a minimal noop.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
})

import { ServerRail } from "./server-rail"
import { TooltipProvider } from "./ui/tooltip"

const HOME = "https://home.example.com"
const PEER = "https://peer.example.com"

const SERVERS = [
  { id: "srv-1", name: "Alpha", initials: "AL", instanceUrl: HOME },
  { id: "srv-2", name: "Beta", initials: "BE", instanceUrl: HOME },
]

describe("ServerRail", () => {
  afterEach(() => cleanup())

  function setup(overrides: Partial<React.ComponentProps<typeof ServerRail>> = {}) {
    return render(
      <TooltipProvider>
        <ServerRail
          servers={SERVERS}
          activeRailTarget={{ id: "srv-1", instanceUrl: HOME }}
          onSelect={() => {}}
          {...overrides}
        />
      </TooltipProvider>
    )
  }

  it("renders one button per server", () => {
    const { container } = setup()
    expect(container.querySelector('[data-slot="server-rail"]')).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument()
  })

  it("calls onSelect with the concrete server target when clicked", async () => {
    const onSelect = vi.fn()
    setup({ onSelect })

    await userEvent.click(screen.getByRole("button", { name: "Beta" }))
    expect(onSelect).toHaveBeenCalledWith({
      id: "srv-2",
      instanceUrl: HOME,
    })
  })

  // Rituals fork: a space belongs to a shared task in Rituals, so the rail
  // menu offers no Leave, Delete or Server settings for any role.
  it("offers no Leave, Delete or Server settings, even to the owner", async () => {
    setup({
      getServerRole: () => "owner",
      onLeaveServer: vi.fn(),
      onDeleteServer: vi.fn(),
      onOpenServerSettings: vi.fn(),
    })

    await userEvent.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: "Alpha" }),
    })

    expect(screen.getByText(/mute space/i)).toBeInTheDocument()
    expect(screen.queryByText(/leave server/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/delete server/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/server settings/i)).not.toBeInTheDocument()
  })

  // Dialog-confirm flow tested via integration in App.test.jsx — Radix
  // AlertDialog uses portals which complicate user-event clicks here.

  it("getServerRole receives the full { id, instanceUrl } target for each rendered server", () => {
    const seen: Array<{ id: string; instanceUrl: string | null }> = []
    setup({
      getServerRole: (target) => {
        seen.push(target)
        return undefined
      },
    })
    // Both rail servers must show up by their (id, instanceUrl) pair.
    expect(seen).toEqual(
      expect.arrayContaining([
        { id: "srv-1", instanceUrl: HOME },
        { id: "srv-2", instanceUrl: HOME },
      ]),
    )
  })

  it("distinguishes same-id servers across instances by passing the right instanceUrl", () => {
    // Two rail entries with the same id but different instanceUrls
    // must each surface their own target to getServerRole.
    const seen: Array<{ id: string; instanceUrl: string | null }> = []
    render(
      <TooltipProvider>
        <ServerRail
          servers={[
            { id: "shared", name: "Home Shared", initials: "HS", instanceUrl: HOME },
            { id: "shared", name: "Peer Shared", initials: "PS", instanceUrl: PEER },
          ]}
          activeRailTarget={{ id: "shared", instanceUrl: PEER }}
          onSelect={() => {}}
          getServerRole={(target) => {
            seen.push(target)
            return undefined
          }}
        />
      </TooltipProvider>
    )
    // React may invoke the render function more than once (StrictMode
    // or concurrent rendering). Assert containment + uniqueness rather
    // than strict-equality on the call sequence.
    const uniq = Array.from(new Set(seen.map((t) => `${t.id}@${t.instanceUrl}`)))
    expect(uniq.sort()).toEqual(
      [`shared@${HOME}`, `shared@${PEER}`].sort()
    )
  })

  it("marks only the matching same-id same-instance entry active", () => {
    render(
      <TooltipProvider>
        <ServerRail
          servers={[
            { id: "shared", name: "Home Shared", initials: "HS", instanceUrl: HOME },
            { id: "shared", name: "Peer Shared", initials: "PS", instanceUrl: PEER },
          ]}
          activeRailTarget={{ id: "shared", instanceUrl: PEER }}
          onSelect={() => {}}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole("button", { name: "Home Shared" })).not.toHaveClass(
      "bg-primary"
    )
    expect(screen.getByRole("button", { name: "Peer Shared" })).toHaveClass(
      "bg-primary"
    )
  })
})
