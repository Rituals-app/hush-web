/**
 * Read-only viewer for the server-log and moderation system channels.
 * Renders a chronological list of system events fetched from the
 * server-side audit feed. No composer, no replies — these channels are
 * generated server-side and immutable from the client.
 */
import * as React from "react"
import { ScrollTextIcon, ShieldAlertIcon } from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area.tsx"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useSystemEvents,
  type SystemEvent,
  type SystemEventSource,
} from "@/adapters/useSystemEvents"

interface WsClientLike {
  on: (event: string, handler: (msg: unknown) => void) => void
  off?: (event: string, handler: (msg: unknown) => void) => void
}

interface SystemChannelViewProps {
  serverId: string
  source: SystemEventSource
  token: string | null
  baseUrl: string
  /** Optional WS client. When provided, the view appends new
   *  system events as the backend broadcasts them, so a long-lived
   *  log surface stays current without manual refresh. */
  wsClient?: WsClientLike | null
  /** Resolves a user id to its render-ready actor label. The system
   *  message rows fall back to a shortened id when this returns
   *  null. Pass the same members snapshot the surrounding chrome
   *  uses so actor / target read the same identity in the log and
   *  in the members sidebar. */
  resolveActorLabel?: (id: string) => string | null
}

/**
 * Header chrome metadata per system-channel source. Exposed so the
 * surrounding ChannelView shell can render the right icon + topic in
 * its header without this body needing a local header.
 */
export const SYSTEM_CHANNEL_HEADERS: Record<
  SystemEventSource,
  { title: string; icon: React.ReactNode; topic: string }
> = {
  "server-log": {
    title: "System log",
    icon: <ScrollTextIcon className="size-5 text-muted-foreground" />,
    topic: "Automatic record of server-wide events",
  },
  moderation: {
    title: "Moderation",
    icon: <ShieldAlertIcon className="size-5 text-muted-foreground" />,
    topic: "Audit log of moderator actions",
  },
}

export function SystemChannelView({
  serverId,
  source,
  token,
  baseUrl,
  wsClient,
  resolveActorLabel,
}: SystemChannelViewProps) {
  const { events, loading, error } = useSystemEvents({
    serverId,
    token,
    baseUrl,
    source,
    wsClient,
  })
  // Header chrome lives on the wrapping ChannelView; this surface
  // only renders the event list.
  void source

  // Header chrome (icon, title, topic, sidebar trigger, members
  // toggle) is owned by ChannelView when this surface is mounted via
  // the shared shell. Render body-only.
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {loading && events.length === 0 ? <SystemSkeleton /> : null}
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              Failed to load events: {error.message}
            </div>
          ) : null}
          {!loading && !error && events.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No events yet.
            </div>
          ) : null}
          {events.map((event) => (
            <SystemEventRow
              key={event.id}
              event={event}
              resolveActorLabel={resolveActorLabel}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function SystemSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

function SystemEventRow({
  event,
  resolveActorLabel,
}: {
  event: SystemEvent
  resolveActorLabel?: (id: string) => string | null
}) {
  const ts = formatTimestamp(event.createdAt)
  if (event.eventType === "member_new_device") {
    // Rituals fork: a later device of a person already here.
    const who = trimOrNull(resolveActorLabel?.(event.actorId)) ?? "Someone"
    return (
      <div className="flex items-baseline justify-between gap-2 px-3 py-1">
        <span className="text-xs text-muted-foreground">
          {who} opened this space on a new device.
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{ts}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{humanizeEventType(event.eventType)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{ts}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        Actor: <ActorTag id={event.actorId} resolveActorLabel={resolveActorLabel} />
        {event.targetId ? (
          <>
            {" · Target: "}
            <ActorTag id={event.targetId} resolveActorLabel={resolveActorLabel} />
          </>
        ) : null}
      </div>
      {event.reason ? (
        <div className="text-xs text-foreground/80">Reason: {event.reason}</div>
      ) : null}
    </div>
  )
}

function ActorTag({
  id,
  resolveActorLabel,
}: {
  id: string
  resolveActorLabel?: (id: string) => string | null
}) {
  const label = trimOrNull(resolveActorLabel?.(id))
  if (label) {
    return <span className="font-medium text-foreground">{label}</span>
  }
  return <span className="font-mono">{shortId(id)}</span>
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function humanizeEventType(t: string): string {
  return t.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function shortId(id: string): string {
  if (id.length <= 8) return id
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      year: "2-digit",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}
