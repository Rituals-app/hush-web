import { Card } from "@/components/ui/card"
import { UserMenu, type UserMenuUser } from "@/components/user-menu"
import { VoicePip } from "@/components/voice-pip"
import { AnimatePresence } from "framer-motion"

// Rituals fork: no bug-report button here. Upstream reports go to the
// upstream author's own server, which is not where Rituals spaces live, so
// the entry point is gone.

interface BottomDockProps {
  user: UserMenuUser
  onOpenUserSettings?: () => void
  onSignOut?: () => void | Promise<void>
  /** Rituals fork: opens the About dialog (AGPL source notice). */
  onOpenAbout?: () => void
  voice?: {
    channelName: string
    serverName: string
    isMuted: boolean
    isDeafened: boolean
    isVideoOn: boolean
    isScreenSharing: boolean
    onToggleMute: () => void
    onToggleDeafen: () => void
    onToggleVideo: () => void
    onToggleScreen: () => void
    onDisconnect: () => void
    onJump: () => void
  }
}

export function BottomDock({
  user,
  onOpenUserSettings,
  onSignOut,
  onOpenAbout,
  voice,
}: BottomDockProps) {
  return (
    <div className="flex w-full flex-col gap-1">
      <AnimatePresence initial={false}>
        {voice ? <VoicePip key="voice-pip" {...voice} /> : null}
      </AnimatePresence>
      <Card
        data-slot="bottom-dock-panel"
        className="gap-0 rounded-lg border-transparent py-0 shadow-none ring-0"
      >
        <UserMenu
          user={user}
          onOpenSettings={onOpenUserSettings}
          onSignOut={onSignOut}
          onOpenAbout={onOpenAbout}
        />
      </Card>
    </div>
  )
}
