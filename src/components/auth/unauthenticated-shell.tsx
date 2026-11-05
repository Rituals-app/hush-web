/**
 * UnauthenticatedShell — top-level rendering switch for non-authenticated
 * boot states. App.jsx mounts this in place of legacy `Home.jsx`.
 *
 * - `needs_pin`     → PinUnlockPanel
 * - `pin_setup`     → PinSetupPanel
 * - `needs_login`   → AuthFlow (mockup port wired to useAuth.performRecovery / performRegister)
 */
import * as React from "react"

import { AuthFlow } from "@/components/auth/auth-flow"
import { PinUnlockPanel } from "@/components/auth/pin-unlock-panel"
import { PinSetupPanel } from "@/components/auth/pin-setup-panel"
import { useAuth } from "@/contexts/AuthContext"
import { useBootController } from "@/hooks/useBootController"
import { useAuthInstanceSelection } from "@/hooks/useAuthInstanceSelection"
import { getInstanceDisplayName } from "@/lib/authInstanceStore"
import { sanitizeDisplayName } from "@/lib/userLabel"
import { APP_VERSION } from "@/utils/constants"

interface KnownInstance {
  url: string
}

interface AuthInstanceState {
  selectedInstanceUrl: string
  knownInstances: KnownInstance[]
  chooseInstance: (url: string) => Promise<string>
  rememberSelectedInstance: (url?: string) => Promise<string>
}

export function UnauthenticatedShell() {
  const { bootState } = useBootController() as { bootState: string }
  const auth = useAuth() as {
    performRegister: (
      username: string,
      displayName: string,
      mnemonic: string,
      inviteCode: string | undefined,
      instanceUrl: string
    ) => Promise<void>
    performRecovery: (
      mnemonic: string,
      revokeOtherDevices: boolean,
      instanceUrl: string
    ) => Promise<void>
    user: { id: string } | null
    hasVault: boolean
    authInvalidation: { reason: string } | null
    clearAuthInvalidation: () => void
  }
  const {
    authInvalidation,
    clearAuthInvalidation,
    performRegister,
    performRecovery,
  } = auth
  const {
    selectedInstanceUrl,
    knownInstances,
    chooseInstance,
    rememberSelectedInstance,
  } = useAuthInstanceSelection() as AuthInstanceState

  // When user clicks "Not you? Sign in" on the PIN unlock screen, force the
  // AuthFlow recovery view even though bootState would otherwise route to
  // PinUnlockPanel. Submitting a different mnemonic creates a new session.
  const [forceRecovery, setForceRecovery] = React.useState(false)

  if (bootState === "needs_pin" && !forceRecovery && !authInvalidation) {
    return <PinUnlockPanel onSwitchAccount={() => setForceRecovery(true)} />
  }
  if (bootState === "pin_setup") return <PinSetupPanel />

  const instanceProps = {
    instances: knownInstances.map((i) => getInstanceDisplayName(i.url)),
    active: getInstanceDisplayName(selectedInstanceUrl),
    onSelect: (label: string) => {
      const match = knownInstances.find(
        (i) => getInstanceDisplayName(i.url) === label
      )
      void chooseInstance(match?.url ?? label)
    },
    onAdd: (label: string) => {
      const url = label.startsWith("http") ? label : `https://${label}`
      void chooseInstance(url)
    },
  }

  const signIn = async (mnemonic: string) => {
    const instanceUrl = await rememberSelectedInstance(selectedInstanceUrl)
    await performRecovery(mnemonic, false, instanceUrl)
  }

  const signUp = async ({
    username,
    displayName,
    mnemonic,
  }: {
    username: string
    displayName: string
    mnemonic: string
  }) => {
    const instanceUrl = await rememberSelectedInstance(selectedInstanceUrl)
    const finalDisplayName = sanitizeDisplayName(displayName, username)
    await performRegister(username, finalDisplayName, mnemonic, undefined, instanceUrl)
    // performRegister flips bootState to 'pin_setup'; PinSetupPanel mounts
    // on next render and owns the PIN commit through useAuth().setPIN.
  }

  return (
    <AuthFlow
      instanceProps={instanceProps}
      instanceUrl={selectedInstanceUrl}
      signIn={signIn}
      signUp={signUp}
      // Rituals fork: no roadmap page (and no instance picker in AuthFlow).
      // Only forward the PIN return path when the user came here by
      // clicking "Not you? Sign in" on the unlock screen. Without an
      // existing session there is no PIN to go back to.
      onBackToPin={
        forceRecovery || authInvalidation
          ? () => {
              clearAuthInvalidation()
              setForceRecovery(false)
            }
          : undefined
      }
      versionLabel={`v${APP_VERSION}`}
    />
  )
}
