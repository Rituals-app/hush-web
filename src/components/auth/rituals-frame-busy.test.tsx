/**
 * Rituals fork (2026-11-06): the screens that wait on the person tell the
 * Rituals pane at once (`{type:"busy"}` via postRitualsFrameBusy), so the
 * pane shows them instead of keeping them hidden until its settle timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

const postRitualsFrameBusy = vi.fn()
vi.mock("@/lib/ritualsSpace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ritualsSpace")>()),
  postRitualsFrameBusy: () => postRitualsFrameBusy(),
}))

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    unlockVault: vi.fn(),
    setPIN: vi.fn(),
    skipPinSetup: vi.fn(),
    user: { username: "alice", display_name: "Alice" },
  }),
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
  useIsTouchDevice: () => false,
}))

vi.mock("@/hooks/useBodyScrollMode", () => ({
  BODY_SCROLL_MODE: { LOCKED: "locked", SCROLL: "scroll" },
  useBodyScrollMode: () => {},
}))

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}))

import { PinUnlockPanel } from "./pin-unlock-panel"
import { PinSetupPanel } from "./pin-setup-panel"
import { AuthFlow } from "./auth-flow"

describe("Rituals pane busy signal", () => {
  beforeEach(() => {
    postRitualsFrameBusy.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it("is sent once when the PIN unlock screen shows", () => {
    const { rerender } = render(<PinUnlockPanel />)
    rerender(<PinUnlockPanel />)
    expect(postRitualsFrameBusy).toHaveBeenCalledTimes(1)
  })

  it("is sent once when the PIN setup screen shows", () => {
    const { rerender } = render(<PinSetupPanel />)
    rerender(<PinSetupPanel />)
    expect(postRitualsFrameBusy).toHaveBeenCalledTimes(1)
  })

  it("is sent when the sign-in and link-this-device screen shows", () => {
    render(
      <AuthFlow
        instanceProps={{ instances: [], active: "", onSelect: vi.fn(), onAdd: vi.fn() }}
        instanceUrl="https://space.example"
        signIn={vi.fn()}
        signUp={vi.fn()}
      />
    )
    expect(postRitualsFrameBusy).toHaveBeenCalledTimes(1)
  })
})
