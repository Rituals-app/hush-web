import * as React from "react"
import {
  HashIcon,
  BellIcon,
  BellOffIcon,
  CheckCheckIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button.tsx"
import { RitualsMark } from "@/components/brand/HushLogo"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx"
import type { MemberRole } from "@/components/members-sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx"
import {
  serverTargetsMatch,
  type ServerActionTarget,
} from "./authenticated-app-server-actions"

type Server = {
  id: string
  name: string
  initials: string
  /**
   * Instance origin that owns this guild. Required so destructive /
   * settings callbacks fired from this rail can be scoped to the
   * exact instance even when the same `id` exists on more than one
   * connected instance. `null` only for shells that have not wired
   * the field yet — handlers should treat that as "no target".
   */
  instanceUrl: string | null
}

export type RailSelection = "home" | ServerActionTarget

interface ServerRailProps {
  servers: Server[]
  activeRailTarget: RailSelection
  onSelect: (target: RailSelection) => void
  /** Returns the current user's role on the given server. */
  getServerRole?: (target: ServerActionTarget) => MemberRole | undefined
  /**
   * Rituals fork: accepted but ignored. A space belongs to a shared task
   * in Rituals, so the rail offers no Leave, Delete, Server settings, Add
   * server or Discover entries (the server refuses them as well).
   */
  onLeaveServer?: (target: ServerActionTarget) => Promise<void> | void
  onDeleteServer?: (target: ServerActionTarget) => Promise<void> | void
  onOpenServerSettings?: (target: ServerActionTarget) => void
  onCreateServer?: () => void
  onDiscoverServers?: () => void
}

export function ServerRail({
  servers,
  activeRailTarget,
  onSelect,
  getServerRole,
}: ServerRailProps) {
  const scrollRootRef = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ top: false, bottom: true })

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.altKey) return
      const order: RailSelection[] = [
        "home",
        ...servers.map((s) => ({ id: s.id, instanceUrl: s.instanceUrl })),
      ]
      const idx = order.findIndex((entry) =>
        railSelectionsMatch(entry, activeRailTarget)
      )
      const currentIndex = idx >= 0 ? idx : 0
      if (event.key === "ArrowDown") {
        event.preventDefault()
        onSelect(order[(currentIndex + 1) % order.length])
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        onSelect(order[(currentIndex - 1 + order.length) % order.length])
      } else if (event.key === "Home") {
        event.preventDefault()
        onSelect("home")
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [servers, activeRailTarget, onSelect])

  React.useEffect(() => {
    const viewport = scrollRootRef.current
    if (!viewport) return

    const update = () => {
      const canScrollUp = viewport.scrollTop > 4
      const canScrollDown =
        viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight - 4
      setEdges((prev) =>
        prev.top === canScrollUp && prev.bottom === canScrollDown
          ? prev
          : { top: canScrollUp, bottom: canScrollDown }
      )
    }
    update()
    viewport.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(viewport)
    const inner = viewport.firstElementChild
    if (inner) ro.observe(inner)
    return () => {
      viewport.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [servers.length])

  return (
    <aside data-slot="server-rail" className="fixed inset-y-0 left-0 z-30 hidden w-(--rail-width) flex-col items-center bg-transparent py-3 pl-2 md:flex">
      <div className="flex flex-col items-center gap-2 pb-2">
        <RailIcon
          label="Home"
          icon={<RitualsMark className="size-5" />}
          active={activeRailTarget === "home"}
          onClick={() => onSelect("home")}
        />
        <RailDivider />
      </div>
      <div className="relative min-h-0 w-full flex-1">
        <div
          ref={scrollRootRef}
          className="h-full w-full overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:bg-transparent"
        >
          <div className="flex flex-col items-center gap-2 px-2 py-1">
            {servers.map((server) => (
              <RailServer
                key={`${server.id}@${server.instanceUrl ?? ""}`}
                server={server}
                active={railSelectionsMatch(
                  { id: server.id, instanceUrl: server.instanceUrl },
                  activeRailTarget
                )}
                onClick={(target) => onSelect(target)}
                role={getServerRole?.({
                  id: server.id,
                  instanceUrl: server.instanceUrl,
                })}
              />
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-3 transition-opacity",
            edges.top ? "opacity-100 duration-300" : "opacity-0 duration-50"
          )}
          style={{
            backgroundImage:
              "linear-gradient(to bottom, var(--desktop-chrome-bg), transparent)",
          }}
        />
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-3 transition-opacity",
            edges.bottom ? "opacity-100 duration-300" : "opacity-0 duration-50"
          )}
          style={{
            backgroundImage:
              "linear-gradient(to top, var(--desktop-chrome-bg), transparent)",
          }}
        />
      </div>
      {/* Rituals fork: no Add server / Discover here. Spaces are created
          by Rituals, one per shared task. */}
    </aside>
  )
}

function RailServer({
  server,
  active,
  onClick,
}: {
  server: Server
  active: boolean
  onClick: (target: ServerActionTarget) => void
  role?: MemberRole
}) {
  const target: ServerActionTarget = {
    id: server.id,
    instanceUrl: server.instanceUrl,
  }

  // Rituals fork: the context menu keeps only the name and the (still
  // backend-less, disabled) notification entries. No Server settings,
  // Privacy settings, Leave or Delete: a space belongs to a shared task in
  // Rituals, and people leave it by leaving the task there.
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onClick(target)}
              className={cn(
                "group relative !size-11 rounded-2xl bg-sidebar-accent/85 p-0 text-sm font-semibold text-sidebar-accent-foreground hover:rounded-xl hover:bg-primary hover:text-primary-foreground",
                active && "rounded-xl bg-primary text-primary-foreground"
              )}
              aria-label={server.name}
              aria-current={active ? "true" : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute -left-[10px] h-0 w-1 rounded-r-full bg-foreground transition-all",
                  active ? "h-8" : "group-hover:h-5"
                )}
              />
              {server.initials}
            </Button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right">{server.name}</TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="text-xs text-muted-foreground">
          {server.name}
        </ContextMenuLabel>
        {/* Mute presets, notification prefs and mark-as-read have no
            backend handler yet; they render disabled as upstream does. */}
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled>
            <BellOffIcon className="size-4" />
            Mute space
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem disabled>For 15 minutes</ContextMenuItem>
            <ContextMenuItem disabled>For 1 hour</ContextMenuItem>
            <ContextMenuItem disabled>For 8 hours</ContextMenuItem>
            <ContextMenuItem disabled>Until tomorrow</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled>Until I turn it back on</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled>
          <BellIcon className="size-4" />
          Notification settings
        </ContextMenuItem>
        <ContextMenuItem disabled>
          <CheckCheckIcon className="size-4" />
          Mark space as read
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function railSelectionsMatch(
  a: RailSelection,
  b: RailSelection
): boolean {
  if (a === "home" || b === "home") return a === b
  return serverTargetsMatch(a, b)
}

function RailIcon({
  label,
  icon,
  active,
  muted,
  disabled,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active?: boolean
  muted?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "!size-11 rounded-2xl bg-sidebar-accent/85 p-0 text-sidebar-accent-foreground hover:rounded-xl hover:bg-primary hover:text-primary-foreground [&_svg:not([class*='size-'])]:size-5",
            active && "rounded-xl bg-primary text-primary-foreground",
            muted &&
              "bg-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            disabled && "opacity-60 hover:bg-transparent hover:text-muted-foreground"
          )}
          aria-label={label}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function RailDivider() {
  return <div className="h-px w-8 rounded bg-border" aria-hidden />
}

export type { Server }
export { HashIcon }
