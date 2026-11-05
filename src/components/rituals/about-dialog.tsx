/**
 * About Rituals Space, with the AGPL-3.0 notice (Rituals fork, 2026-11-05).
 *
 * Spaces run a modified Hush web client, server and crypto library. AGPL-3.0
 * section 13 asks for the Corresponding Source to be offered to everyone
 * using the modified program over a network, and section 5(a) for a dated
 * notice of the modification. This dialog carries both; it is reachable from
 * the channel sidebar footer ("About", next to "Source") and the user menu.
 * The links come from build-time constants (VITE_RITUALS_SOURCE_*), which
 * default to the host's source listing at https://space.rit.al/source/.
 */
import * as React from "react"
import { ArrowUpRightIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RitualsMark } from "@/components/brand/HushLogo"
import {
  RITUALS_HOME_URL,
  SPACE_MODIFIED_ON,
  SPACE_SOURCE_COMMIT,
  SPACE_SOURCE_LINKS,
  isInRitualsHost,
} from "@/lib/ritualsSpace"
import { APP_VERSION } from "@/utils/constants"

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground underline underline-offset-4"
    >
      {children}
    </a>
  )
}

export function RitualsAboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const inHost = isInRitualsHost()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="items-center text-center">
          <RitualsMark className="mb-1 size-11" />
          <DialogTitle>Rituals Space</DialogTitle>
          <DialogDescription>
            A private space for the people on a shared task. Messages and
            calls are end-to-end encrypted.
          </DialogDescription>
        </DialogHeader>
        <p
          className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
          data-testid="rituals-agpl-notice"
        >
          Spaces run a modified version of Hush by hushhq, free software under
          the GNU Affero General Public License v3. Modified by Rituals,{" "}
          {SPACE_MODIFIED_ON}. Source code for this version:{" "}
          <SourceLink href={SPACE_SOURCE_LINKS.web}>Web</SourceLink>
          {" · "}
          <SourceLink href={SPACE_SOURCE_LINKS.server}>Server</SourceLink>
          {" · "}
          <SourceLink href={SPACE_SOURCE_LINKS.crypto}>Crypto</SourceLink>
          {" · "}
          <SourceLink href={SPACE_SOURCE_LINKS.license}>License</SourceLink>
          . No warranty.
        </p>
        <div className="flex flex-col items-center gap-2">
          {inHost ? null : (
            <a
              href={RITUALS_HOME_URL}
              className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
            >
              Rituals
              <ArrowUpRightIcon className="size-3.5" />
            </a>
          )}
          <span className="font-mono text-[10px] text-muted-foreground/70">
            v{APP_VERSION}
            {SPACE_SOURCE_COMMIT ? ` · ${SPACE_SOURCE_COMMIT.slice(0, 12)}` : ""}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The small links under the channel sidebar: Rituals home (normal browser
 * tabs only; the native app has its own way back), About, Source.
 */
export function RitualsSidebarFooterLinks({ onOpenAbout }: { onOpenAbout: () => void }) {
  const inHost = isInRitualsHost()
  const linkClass =
    "rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
  return (
    <nav
      aria-label="Rituals Space"
      className="flex items-center justify-center gap-1.5 px-2 pb-0.5 text-[11px] text-muted-foreground"
    >
      {inHost ? null : (
        <>
          <a href={RITUALS_HOME_URL} className={`${linkClass} inline-flex items-center gap-0.5`}>
            Rituals
            <ArrowUpRightIcon className="size-3" />
          </a>
          <span aria-hidden>·</span>
        </>
      )}
      <button type="button" onClick={onOpenAbout} className={linkClass}>
        About
      </button>
      <span aria-hidden>·</span>
      <a
        href={SPACE_SOURCE_LINKS.index}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        Source
      </a>
    </nav>
  )
}
