/**
 * Fetches a guild's roster via the instance HTTP API and maps it to the
 * prototype's `ServerMember[]` shape. Presence comes from server-pushed
 * events later (placeholder "online" for now).
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { getGuildMembers } from "@/lib/api"
import { formatUserLabel } from "@/lib/userLabel"
import { unifyPeople } from "@/lib/spacePeople"

import {
  type ServerMember,
  deriveInitials,
  memberRoleFromRaw,
} from "./types"

interface RawMember {
  id?: string
  userId?: string
  username?: string | null
  displayName?: string | null
  permissionLevel?: number
  role?: string
  createdAt?: string | null
  joinedAt?: string | null
  homeInstance?: string | null
  personKey?: string | null
}

interface UseMembersArgs {
  serverId: string | null
  token: string | null
  baseUrl: string
  currentUserId: string | null
  /** Optional set of currently-online user ids. When provided AND
   *  `hasOnlineSnapshot` is true, the returned `members[].presence`
   *  reflects WS-driven presence state. Without a snapshot, falls
   *  back to "online" for every row so the initial render does not
   *  flip every member to offline before the first
   *  `presence.update` lands. */
  onlineUserIds?: ReadonlySet<string>
  /** True once at least one `presence.update` frame has arrived.
   *  Required to interpret `onlineUserIds` correctly — see comment
   *  on the field above. */
  hasOnlineSnapshot?: boolean
}

interface UseMembersResult {
  members: ServerMember[]
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function membersForServerQueryKey({
  serverId,
  baseUrl,
  currentUserId,
}: Pick<UseMembersArgs, "serverId" | "baseUrl" | "currentUserId">) {
  return [
    "servers",
    baseUrl || "local",
    serverId ?? "none",
    "members",
    currentUserId ?? "anonymous",
  ] as const
}

export function useMembersForServer({
  serverId,
  token,
  baseUrl,
  currentUserId,
  onlineUserIds,
  hasOnlineSnapshot,
}: UseMembersArgs): UseMembersResult {
  const isQueryEnabled = Boolean(serverId && token)
  const query = useQuery<RawMember[], Error>({
    queryKey: membersForServerQueryKey({ serverId, baseUrl, currentUserId }),
    enabled: isQueryEnabled,
    queryFn: async () => {
      if (!serverId || !token) return []
      const data = (await getGuildMembers(token, serverId, baseUrl)) as unknown
      return Array.isArray(data) ? (data as RawMember[]) : []
    },
  })

  const raw = query.data ?? []

  const members = React.useMemo<ServerMember[]>(
    () =>
      unifyPeople(
        raw.map((m) => mapRawMember(m, onlineUserIds, hasOnlineSnapshot))
      ),
    [raw, onlineUserIds, hasOnlineSnapshot]
  )

  const refetch = React.useCallback(async () => {
    if (!serverId || !token) return
    await query.refetch()
  }, [query.refetch, serverId, token])

  return {
    members,
    loading: query.isFetching && isQueryEnabled,
    error: query.error ?? null,
    refetch,
  }
}

export function mapRawMember(
  m: RawMember,
  onlineUserIds: ReadonlySet<string> | undefined,
  hasOnlineSnapshot: boolean | undefined
): ServerMember {
  const id = m.id ?? m.userId ?? ""
  const username = nonBlankOrNull(m.username)
  const displayName = nonBlankOrNull(m.displayName)
  const name = formatUserLabel({
    displayName,
    username,
    fallback: "user",
  })
  return {
    id,
    name,
    initials: deriveInitials(name),
    presence:
      onlineUserIds && hasOnlineSnapshot
        ? onlineUserIds.has(id)
          ? "online"
          : "offline"
        : "online",
    role: memberRoleFromRaw({
      permissionLevel: m.permissionLevel,
      role: m.role,
    }),
    username,
    displayName,
    createdAt: nonBlankOrNull(m.createdAt),
    joinedAt: nonBlankOrNull(m.joinedAt),
    homeInstance: nonBlankOrNull(m.homeInstance),
    ...(nonBlankOrNull(m.personKey)
      ? { personKey: nonBlankOrNull(m.personKey) }
      : {}),
  }
}

function nonBlankOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
