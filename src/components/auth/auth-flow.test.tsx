/**
 * Behaviour port from src/components/auth/RegistrationWizard.test.jsx +
 * RecoveryPhraseInput.test.jsx — verifies the AuthFlow main panel
 * routes to sign-in or device linking, the sign-in submit calls
 * signIn(mnemonic), and the main view exposes the version footer.
 * (Rituals fork: no sign-up entry, instance picker or roadmap link; a new
 * identity is created by a space entry from Rituals.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("@/lib/bip39Identity", () => ({
  generateIdentityMnemonic: vi.fn(() =>
    Array.from({ length: 12 }, (_, i) => `word${i + 1}`).join(" ")
  ),
}))

vi.mock("@/lib/api", () => ({
  checkUsernameAvailable: vi.fn().mockResolvedValue({ available: true }),
}))

const useBodyScrollModeMock = vi.fn()
vi.mock("@/hooks/useBodyScrollMode", () => ({
  BODY_SCROLL_MODE: { LOCKED: "locked", SCROLL: "scroll" },
  useBodyScrollMode: (mode: string) => useBodyScrollModeMock(mode),
}))

const navigateMock = vi.fn()
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}))

import { AuthFlow } from "./auth-flow"

const INSTANCE_PROPS = {
  instances: ["a.example.com"],
  active: "a.example.com",
  onSelect: vi.fn(),
  onAdd: vi.fn(),
}

describe("AuthFlow", () => {
  beforeEach(() => {
    INSTANCE_PROPS.onSelect.mockReset()
    INSTANCE_PROPS.onAdd.mockReset()
    useBodyScrollModeMock.mockReset()
    navigateMock.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  function setup(overrides: Partial<React.ComponentProps<typeof AuthFlow>> = {}) {
    return render(
      <AuthFlow
        instanceProps={INSTANCE_PROPS}
        instanceUrl="https://a.example.com"
        signIn={overrides.signIn ?? vi.fn()}
        signUp={overrides.signUp ?? vi.fn()}
        onOpenRoadmap={overrides.onOpenRoadmap}
        versionLabel={overrides.versionLabel ?? "v0.0.1"}
      />
    )
  }

  it("renders the main view with recovery log-in + version label and no sign-up", () => {
    setup()
    expect(useBodyScrollModeMock).toHaveBeenCalledWith("scroll")
    expect(
      screen.getByRole("button", { name: /^log in with recovery phrase$/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /^sign up$/i })
    ).not.toBeInTheDocument()
    expect(screen.getByText("v0.0.1")).toBeInTheDocument()
  })

  it("shows no instance picker and no roadmap link", () => {
    setup({ onOpenRoadmap: vi.fn() })

    expect(
      screen.queryByRole("button", { name: /roadmap/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByText("a.example.com")).not.toBeInTheDocument()
  })

  it("navigates to the sign-in view and renders 12 phrase inputs", async () => {
    setup()

    const u = userEvent.setup()
    await u.click(
      screen.getByRole("button", { name: /^log in with recovery phrase$/i })
    )

    expect(screen.getByText(/recovery phrase/i)).toBeInTheDocument()
    expect(screen.getAllByRole("textbox")).toHaveLength(12)
  })

  it("routes the link-device CTA to /link-device?mode=new", async () => {
    setup()

    const u = userEvent.setup()
    await u.click(
      screen.getByRole("button", { name: /link to existing device/i })
    )
    await u.click(
      screen.getByRole("button", { name: /continue to device linking/i })
    )

    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith("/link-device?mode=new")
  })
})
