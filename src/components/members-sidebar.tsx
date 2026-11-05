import * as React from "react"
import {
  AtSignIcon,
  BanIcon,
  CopyIcon,
  CrownIcon,
  MessageSquareIcon,
  ShieldIcon,
  UserIcon,
  UserPlusIcon,
} from "lucide-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover.tsx"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UsernameHandle } from "@/components/identity/username-handle"
import { formatUsername } from "@/lib/userLabel"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"

export type MemberPresence = "online" | "idle" | "dnd" | "offline"
export type MemberRole = "owner" | "admin" | "moderator" | "member" | "bot"

export interface ServerMember {
  id: string
  name: string
  initials: string
  presence?: MemberPresence
  role: MemberRole
  username?: string | null
  displayName?: string | null
  createdAt?: string | null
  joinedAt?: string | null
  homeInstance?: string | null
}

interface MembersSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName: string
  members: ServerMember[]
  isMobile: boolean
  /** Current user's role on this server. Drives permission-gated actions. */
  currentUserRole?: MemberRole
  /** Real handler when present; undefined → kick item disabled. */
  onKickMember?: (member: ServerMember, reason: string) => void | Promise<void>
  /** Open or create a direct message with the given member. */
  onDirectMessage?: (member: ServerMember) => void | Promise<void>
}

const ROLE_ORDER: MemberRole[] = ["owner", "admin", "moderator", "member"]

const ROLE_PRIORITY: Record<MemberRole, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  bot: 1,
  member: 1,
}

function canKick(actor: MemberRole | undefined, target: MemberRole): boolean {
  if (!actor) return false
  if (actor === "member" || actor === "bot") return false
  return ROLE_PRIORITY[actor] > ROLE_PRIORITY[target]
}

const ROLE_LABEL: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admins",
  moderator: "Moderators",
  bot: "Bots",
  member: "Members",
}

const ROLE_ICON: Record<MemberRole, React.ReactNode> = {
  owner: <CrownIcon className="size-3.5" />,
  admin: <ShieldIcon className="size-3.5" />,
  moderator: <ShieldIcon className="size-3.5" />,
  bot: <UserIcon className="size-3.5" />,
  member: <UserIcon className="size-3.5" />,
}

const PANEL_WIDTH = "16rem"

export function MembersSidebar({
  open,
  onOpenChange,
  serverName,
  members,
  isMobile,
  currentUserRole,
  onKickMember,
  onDirectMessage,
}: MembersSidebarProps) {
  const grouped = React.useMemo(
    () =>
      ROLE_ORDER.map((role) => ({
        role,
        items: members.filter((m) => m.role === role),
      })).filter((group) => group.items.length > 0),
    [members]
  )

  const body = (
    <MembersList
      grouped={grouped}
      currentUserRole={currentUserRole}
      onKickMember={onKickMember}
      onDirectMessage={onDirectMessage}
    />
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-72 flex-col gap-0 bg-card p-0">
          <SheetHeader className="flex h-14 shrink-0 flex-row items-center justify-between border-b px-4 py-0 space-y-0">
            <SheetTitle className="text-sm font-semibold">Members</SheetTitle>
            <SheetDescription className="text-xs">
              {serverName} · {members.length}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      data-state={open ? "open" : "closed"}
      style={{ width: open ? PANEL_WIDTH : "0px" }}
      className={cn(
        "h-full shrink-0 overflow-clip border-l transition-[width] duration-200 ease-in-out"
      )}
    >
      <div
        style={{ width: PANEL_WIDTH }}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <span className="text-sm font-semibold">Members</span>
          <span className="text-xs text-muted-foreground">{members.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </div>
    </aside>
  )
}

const ROLE_BADGE_LABEL: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator",
  bot: "Bot",
  member: "Member",
}

interface MemberRowProps {
  member: ServerMember
  currentUserRole?: MemberRole
  onKickMember?: (member: ServerMember, reason: string) => void | Promise<void>
  onDirectMessage?: (member: ServerMember) => void | Promise<void>
}

function MemberRow({
  member,
  currentUserRole,
  onKickMember,
  onDirectMessage,
}: MemberRowProps) {
  const [profileOpen, setProfileOpen] = React.useState(false)
  const isMobile = useIsMobile()
  const [kickOpen, setKickOpen] = React.useState(false)
  const [kickReason, setKickReason] = React.useState("")
  const [kickBusy, setKickBusy] = React.useState(false)
  const [kickError, setKickError] = React.useState<string | null>(null)
  const showKick = canKick(currentUserRole, member.role) && Boolean(onKickMember)

  const confirmKick = React.useCallback(async () => {
    const reason = kickReason.trim()
    if (!reason) {
      setKickError("Kick reason required")
      return
    }
    if (!onKickMember) return
    // Close BEFORE awaiting the mutation. The kick triggers a member
    // refresh that may unmount this row while the AlertDialog is still
    // mid-close, leaking Radix's body `pointer-events: none` lock and
    // freezing the UI until reload.
    setKickError(null)
    setKickOpen(false)
    setKickBusy(true)
    try {
      await onKickMember(member, reason)
      setKickReason("")
    } catch (err) {
      setKickError(err instanceof Error ? err.message : "Failed to kick member")
      setKickOpen(true)
    } finally {
      setKickBusy(false)
    }
  }, [kickReason, member, onKickMember])

  return (
    <Popover open={profileOpen} onOpenChange={setProfileOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverAnchor asChild>
            <button
              type="button"
              onClick={() => setProfileOpen((p) => !p)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 data-[state=open]:bg-muted/60"
              data-state={profileOpen ? "open" : "closed"}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                {member.initials}
              </span>
              <span className="truncate text-sm">{member.name}</span>
            </button>
          </PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {/* Member-context actions are gated until the granular RBAC
              + member-graph work lands (see docs/tech-debt/granular-rbac.md).
              Render every entry disabled+muted so the affordance signals
              "shipping soon" without exposing partially-wired surface. */}
          <ContextMenuItem disabled>
            <UserIcon />
            View profile
          </ContextMenuItem>
          <ContextMenuItem disabled>
            <MessageSquareIcon />
            Send message
          </ContextMenuItem>
          <ContextMenuItem disabled>
            <AtSignIcon />
            Mention in channel
          </ContextMenuItem>
          <ContextMenuItem disabled>
            <UserPlusIcon />
            Add friend
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled>
            <CopyIcon />
            Copy user ID
          </ContextMenuItem>
          {showKick ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" disabled>
                <BanIcon />
                Remove from space
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent
        side={isMobile ? "bottom" : "left"}
        align={isMobile ? "center" : "start"}
        sideOffset={12}
        collisionPadding={8}
        className="w-[min(18rem,calc(100vw-1rem))] p-0"
      >
        <ProfileCard member={member} onDirectMessage={onDirectMessage} />
      </PopoverContent>
      {showKick ? (
        <AlertDialog open={kickOpen} onOpenChange={setKickOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Kick {member.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {member.name} will be removed from this space.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`kick-reason-${member.id}`}>Reason</Label>
              <Input
                id={`kick-reason-${member.id}`}
                value={kickReason}
                onChange={(event) => {
                  setKickReason(event.target.value)
                  setKickError(null)
                }}
                disabled={kickBusy}
                placeholder="Reason"
              />
              {kickError ? (
                <div className="text-sm text-destructive">{kickError}</div>
              ) : null}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={kickBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={kickBusy}
                onClick={(event) => {
                  event.preventDefault()
                  void confirmKick()
                }}
              >
                {kickBusy ? "Kicking..." : "Kick"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Popover>
  )
}

function ProfileCard({
  member,
  onDirectMessage,
}: {
  member: ServerMember
  onDirectMessage?: (member: ServerMember) => void | Promise<void>
}) {
  const username = formatUsername(member.username) || null
  const memberSince = formatMemberSince(member.joinedAt ?? member.createdAt)
  return (
    <div className="flex flex-col">
      <div className="h-14 rounded-t-md bg-gradient-to-br from-primary/30 to-primary/5" />
      <div className="-mt-7 flex flex-col gap-3 px-4 pb-4">
        <span className="flex size-14 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground">
          {member.initials}
        </span>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold">{member.name}</span>
          {username ? (
            <UsernameHandle
              username={username}
              className="text-xs text-muted-foreground"
            />
          ) : null}
          <span className="text-xs text-muted-foreground">
            {ROLE_BADGE_LABEL[member.role]}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Member since</span>
            <span>{memberSince}</span>
          </div>
        </div>
        {/* Send message is intentionally inert until DMs ship from
            the server-member popover. Render disabled so the
            affordance stays visible without firing a half-wired
            handler. */}
        <button
          type="button"
          disabled
          className="flex h-8 cursor-not-allowed items-center justify-center gap-2 rounded-md bg-muted text-xs font-medium opacity-50"
        >
          <MessageSquareIcon className="size-3.5" />
          Send message
        </button>
      </div>
    </div>
  )
}

function formatMemberSince(value: string | null | undefined): string {
  if (!value) return "Unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  })
}

interface GroupedMembers {
  role: MemberRole
  items: ServerMember[]
}

interface MembersListProps {
  grouped: GroupedMembers[]
  currentUserRole?: MemberRole
  onKickMember?: (member: ServerMember, reason: string) => void | Promise<void>
  onDirectMessage?: (member: ServerMember) => void | Promise<void>
}

function MembersList({
  grouped,
  currentUserRole,
  onKickMember,
  onDirectMessage,
}: MembersListProps) {
  return (
    <div className="flex flex-col gap-4 p-3">
      {grouped.map((group) => (
        <section key={group.role} className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {ROLE_ICON[group.role]}
            <span>
              {ROLE_LABEL[group.role]} · {group.items.length}
            </span>
          </div>
          <ul className="flex flex-col">
            {group.items.map((member) => (
              <li key={member.id}>
                <MemberRow
                  member={member}
                  currentUserRole={currentUserRole}
                  onKickMember={onKickMember}
                  onDirectMessage={onDirectMessage}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
