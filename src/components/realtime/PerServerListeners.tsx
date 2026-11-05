import * as React from "react"
import { toast } from "sonner"

import { useGuildChannelIds } from "@/hooks/useGuildChannelIds"
import { useTextChannelMLSSubscriptions } from "@/hooks/useTextChannelMLSSubscriptions"
import { useServerModerationEvents } from "@/adapters/useServerModerationEvents"
import { useServerJoinEvents } from "@/adapters/useServerJoinEvents"
import { RITUALS_HOME_URL, isInRitualsHost } from "@/lib/ritualsSpace"

interface WsClientLike {
  on: (event: string, handler: (msg: unknown) => void) => void
  off?: (event: string, handler: (msg: unknown) => void) => void
  subscribeChannel: (channelId: string) => void
  unsubscribeChannel: (channelId: string) => void
}

interface PerServerListenersProps {
  instanceUrl: string
  wsClient: WsClientLike
  token: string
  currentUserId: string | null
  serverId: string
  /** Display name of the server, used in the self-removed toast.
   *  When unknown, the toast falls back to the generic "the
   *  server" copy from useServerModerationEvents. */
  serverName?: string
  /** Fired when the active member-list snapshot for this server
   *  needs to refetch (member_kicked / member_banned / member_muted
   *  / member_role_changed). For inactive servers this is a no-op
   *  because no member-list query is mounted. */
  refetchMembers: () => Promise<void> | void
  /** Fired when the local user is the kick / ban target for this
   *  server. The shell already handles MLS cleanup + toast; this
   *  callback lets the parent route the user away if they were
   *  viewing the affected server. */
  onSelfRemoved: (info: {
    instanceUrl: string
    serverId: string
    event: "kick" | "ban"
    reason?: string
  }) => void
}

/**
 * Mounts every per-server realtime listener for one (instance,
 * server) pair, regardless of whether that server is currently in
 * the active view:
 *   - useGuildChannelIds — fetches text channel ids once so the
 *     downstream subscriptions and MLS cleanup have a working set.
 *   - useTextChannelMLSSubscriptions — joins each text channel
 *     room on this instance's wsClient. Refcounted at the
 *     transport layer so the active chat's subscribe does not
 *     collide.
 *   - useServerModerationEvents — surfaces kick/ban/mute/role for
 *     the matched serverId. Cleans up MLS state for self kick/ban
 *     using the channel ids fetched above. The parent decides
 *     navigation via onSelfRemoved.
 *
 * Renders nothing.
 */
export function PerServerListeners({
  instanceUrl,
  wsClient,
  token,
  currentUserId,
  serverId,
  serverName,
  refetchMembers,
  onSelfRemoved,
}: PerServerListenersProps) {
  const { textChannelIds } = useGuildChannelIds({
    serverId,
    token,
    baseUrl: instanceUrl,
    currentUserId,
  })

  useTextChannelMLSSubscriptions(
    wsClient as Parameters<typeof useTextChannelMLSSubscriptions>[0],
    textChannelIds,
  )

  useServerModerationEvents({
    wsClient: wsClient as Parameters<
      typeof useServerModerationEvents
    >[0]["wsClient"],
    serverId,
    currentUserId,
    refetchMembers,
    textChannelIds,
    onSelfRemoved: ({ event, reason }) => {
      if (event === "kick" && !reason) {
        // Rituals fork: a removal from the shared task in Rituals arrives
        // as a kick with no reason (signed sync). Say what happened and,
        // in a normal browser tab, offer the way back to Rituals (the
        // native app has its own).
        toast.error("You're no longer in this space.", {
          description: "It belongs to a shared task in Rituals.",
          action: isInRitualsHost()
            ? undefined
            : {
                label: "Open Rituals",
                onClick: () => {
                  window.location.assign(RITUALS_HOME_URL)
                },
              },
        })
      } else {
        const named = serverName ?? "this space"
        const verb = event === "kick" ? "removed from" : "banned from"
        const message = reason
          ? `You were ${verb} ${named}: ${reason}`
          : `You were ${verb} ${named}.`
        toast.error(message)
      }
      onSelfRemoved({ instanceUrl, serverId, event, reason })
    },
  })

  useServerJoinEvents({
    wsClient: wsClient as Parameters<typeof useServerJoinEvents>[0]["wsClient"],
    serverId,
    refetchMembers,
  })

  return null
}
