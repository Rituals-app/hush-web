import { Button } from "@/components/ui/button"

interface BlockedTabViewProps {
  /**
   * Optional context for the blocking message. Some flows (device link
   * approval, invite acceptance) need a slightly different prompt so
   * the user understands why they should take over rather than close.
   */
  blockedFlow?: "device-link" | "invite" | null
  /**
   * Hands tab ownership to this tab and unblocks the other one. The
   * caller is responsible for ensuring the takeover happens before any
   * MLS/vault initialization runs in this tab.
   */
  takeOver: () => void
}

/**
 * Full-screen overlay shown when this tab detects another active Hush
 * tab. The single-tab guarantee protects shared MLS/vault state from
 * being mutated concurrently across browser tabs. Theme-synced via the
 * dark class on <html>; uses semantic tokens so it tracks any future
 * palette work without touching this file.
 */
export function BlockedTabView({ blockedFlow, takeOver }: BlockedTabViewProps) {
  const description =
    blockedFlow === "device-link"
      ? "To approve this device here, take over this tab, then unlock your spaces if required."
      : blockedFlow === "invite"
      ? "To continue here, take over this tab, then unlock your spaces if required."
      : "Close the other tab or click below to use this one instead."

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-2">
        <p className="text-lg font-medium text-foreground">
          Rituals Space is already open in another tab.
        </p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button type="button" onClick={takeOver}>
        Use this one instead
      </Button>
    </div>
  )
}
