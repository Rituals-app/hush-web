/**
 * AuthenticatedApp, post-login application shell.
 *
 * Composes ServerRail (servers), ChannelSidebar (channel list with DnD),
 * ChannelView (header + content) and the surrounding dialogs (settings,
 * cheat sheet, command palette). Mounts the legacy Chat.jsx as the message
 * body slot of ChannelView for text channels, that file owns Signal/MLS
 * encryption, WebSocket subscription, and optimistic sends; this shell
 * never recreates that logic.
 *
 * URL-driven: `/:instance/:guildSlug/:channelSlug?` is parsed via
 * react-router, mapped to `Server` + `Channel` through adapters. Voice
 * mute/deafen state is local UI mock for this commit; real LiveKit wiring
 * lands in a follow-up.
 */
import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ScrollTextIcon,
  ShieldAlertIcon,
  InboxIcon,
  StarIcon,
} from "lucide-react"
import type { AdapterSystemChannel, SystemChannelType } from "@/adapters"

import { ChannelSidebar } from "@/components/channel-sidebar"
import type { SystemChannel } from "@/components/channel-sidebar"
import { ChannelView } from "@/components/channel-view"
import {
  SystemChannelView,
  SYSTEM_CHANNEL_HEADERS,
} from "@/components/system-channel-view"
import { ServerRail, type RailSelection } from "@/components/server-rail"
import { CheatSheet } from "@/components/cheat-sheet"
import { UserSettingsDialog } from "@/components/user-settings-dialog"
import { FavoritesView } from "@/components/favorites-view"
import { CommandPalette } from "@/components/command-palette"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip.tsx"
import { RealChat } from "@/components/chat-real"
import { VoiceChannelView } from "@/components/voice-channel-view"
import { VoicePlaceholderView } from "@/components/voice/voice-placeholder-view"
import { useAuth } from "@/contexts/AuthContext"
import { getDeviceId, HOME_INSTANCE_KEY } from "@/hooks/useAuth"
import { useInstanceContext } from "@/contexts/InstanceContext"
import { useInstanceConfig } from "@/hooks/useInstanceConfig"
import {
  readMaxAttachmentBytes,
  readScreenShareResolutionCap,
} from "@/lib/instanceRuntimeConfig"
import * as mlsStore from "@/lib/mlsStore"
import { buildGuildRouteRef, parseGuildRouteRef } from "@/lib/slugify"
import {
  kickUser,
  createGuildChannel,
  deleteGuildChannel,
  createOrFindDM,
} from "@/lib/api"
import {
  RITUALS_HOME_URL,
  isEmbedded,
  postToRitualsHost,
} from "@/lib/ritualsSpace"
import { RitualsMark } from "@/components/brand/HushLogo"
import type {
  MemberRole,
  ServerMember,
} from "@/components/members-sidebar"

import {
  useGuilds,
  useChannelsForServer,
  useMembersForServer,
  deriveInitials,
} from "@/adapters"
import type {
  Server,
  Channel,
  ChannelCategory,
  VoiceParticipantInfo,
} from "@/adapters"
import { useVoiceChannelPresence } from "@/hooks/useVoiceChannelPresence"
import { useOnlinePresence } from "@/hooks/useOnlinePresence"
import {
  formatUserLabel,
  getUserDisplayName,
  sanitizeDisplayName,
} from "@/lib/userLabel"
import { resolveActorLabel } from "@/lib/systemActorLabel"
import { PerInstanceListeners } from "@/components/realtime/PerInstanceListeners"
import { PerServerListeners } from "@/components/realtime/PerServerListeners"
import {
  normalizeOrigin,
  resolveTrustedHomeInstance,
} from "./authenticated-app-home-instance"
import { runInstanceBanAction } from "./authenticated-app-instance-ban"
import {
  resolveServerForAction,
  serverTargetsMatch,
  type ServerActionTarget,
} from "./authenticated-app-server-actions"
import { shouldLeaveVoiceAfterSelfRemoval } from "./authenticated-app-self-removal"

// Rituals fork: a space's lifecycle belongs to Rituals (one space per shared
// task, membership synced from the share). This shell therefore has no
// Create server, Explore/discover, Create invite, Leave or Delete server,
// no "What's new" announcements and no desktop update checks.

const noopRefetch = async () => {}

interface FavoriteEntry {
  id: string
  messageId: string
  body: string
  author: string
  authorInitials: string
  channelId: string
  channelName: string
  channelKind: "text" | "voice"
  serverId: string
  serverName: string
  savedAt: number
}

interface JoinedVoice {
  channelId: string
  channelName: string
  serverId: string
  serverName: string
  instanceUrl: string
}

interface VoiceControls {
  toggleMic?: () => void
  toggleDeafen?: () => void
  toggleScreenShare?: () => void
  switchScreenSource?: () => void
  toggleWebcam?: () => void
  isScreenSharing?: boolean
  isWebcamOn?: boolean
  applyMicFilterSettings?: (settings: Partial<{
    noiseGateEnabled: boolean
    noiseGateThresholdDb: number
  }>) => void
  setOutputDeviceSink?: (deviceId: string | null) => Promise<void> | void
}

interface VoiceState {
  isMicOn: boolean
  isDeafened: boolean
  isScreenSharing: boolean
  isWebcamOn: boolean
}

// HUSHHQ-19: `readScreenShareResolutionCap`, `readMaxAttachmentBytes`,
// the screen-share cap type, and the attachment default live in
// `@/lib/instanceRuntimeConfig` so they stay unit-testable
// without mounting the full app tree.

function systemIconFor(type: SystemChannelType): React.ReactNode {
  return type === "moderation" ? <ShieldAlertIcon /> : <ScrollTextIcon />
}

function adaptSystemChannelsForSidebar(
  rows: AdapterSystemChannel[]
): SystemChannel[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    icon: systemIconFor(row.systemChannelType),
  }))
}

const HOME_SYSTEM_CHANNELS: SystemChannel[] = [
  { id: "catch-up", name: "Catch up", icon: <InboxIcon /> },
  { id: "favorites", name: "Favorites", icon: <StarIcon /> },
]

type ShellChannelKind = Channel["kind"] | "system"

interface ShellChannel {
  id: string
  name: string
  kind: ShellChannelKind
}

export function AuthenticatedApp() {
  const params = useParams<{
    instance?: string
    guildSlug?: string
    channelSlug?: string
  }>()
  const navigate = useNavigate()
  const {
    user,
    performLogout,
    identityKeyRef,
    setTransparencyError,
  } = useAuth() as {
    user: {
      id: string
      username?: string
      displayName?: string
      display_name?: string
    } | null
    performLogout: () => Promise<void>
    identityKeyRef: React.MutableRefObject<{
      publicKey?: Uint8Array
      privateKey?: Uint8Array
    } | null>
    setTransparencyError: (msg: string | null) => void
  }
  const handleSignOut = React.useCallback(async () => {
    await performLogout()
  }, [performLogout])

  const {
    getTokenForInstance,
    getWsClient,
    refreshGuilds,
    dmGuilds,
    connectedInstances,
    disconnectInstance,
    guildsLoaded,
  } = useInstanceContext() as unknown as {
    guildsLoaded: boolean
    getTokenForInstance: (url: string) => string | null
    getWsClient: (url: string) => unknown | null
    refreshGuilds: (instanceUrl: string) => Promise<void>
    connectedInstances: Array<{
      instanceUrl: string
      wsClient: unknown
      token: string
      userId: string
      handshakeData: {
        log_public_key?: string
        screen_share_resolution_cap?: string
        screenShareResolutionCap?: string
        max_attachment_bytes?: number
        maxAttachmentBytes?: number
      } | null
      serverIds: string[]
    }>
    disconnectInstance: (instanceUrl: string) => Promise<void>
    dmGuilds: Array<{
      id: string
      otherUser?: { id: string; username?: string; displayName?: string }
      channelId?: string
      instanceUrl?: string
    }>
  }
  const isMobile = useIsMobile()
  // Rituals fork (INTEGRATED.md §10): in the Rituals hub's frame or the native
  // app, Rituals draws the rail (Task page, Project page, the space), so the
  // space shows no server rail of its own and no shortcut to another space.
  const embedded = React.useMemo(() => isEmbedded(), [])

  // Auth (home) instance, where the JWT lives and the device list is
  // hosted. Distinct from the currently-selected server, which may be a
  // federated peer. Falls back to the page origin during the first paint
  // before useInstances hydrates. Both sides of the lookup are
  // normalized to URL.origin so trailing-slash / case differences in
  // localStorage vs the connected snapshot don't drop the match.
  const homeInstance = React.useMemo(() => {
    const stored =
      typeof window !== "undefined"
        ? localStorage.getItem(HOME_INSTANCE_KEY)
        : null
    const fallback =
      typeof window !== "undefined" ? window.location.origin : null
    return resolveTrustedHomeInstance(stored, fallback, connectedInstances)
  }, [connectedInstances])

  const { servers } = useGuilds()

  // Rail Server shape includes the owning `instanceUrl` so the rail's
  // destructive/settings callbacks can carry the full identity (id +
  // instance) to the action handlers below. The adapter Server keeps
  // `instanceUrl` on its nested `raw` object; flatten it here for the
  // rail consumer.
  const railServers = React.useMemo(
    () =>
      servers.map((s) => ({
        id: s.id,
        name: s.name,
        initials: s.initials,
        instanceUrl: s.raw.instanceUrl,
      })),
    [servers]
  )

  const parsedGuild = React.useMemo(
    () => (params.guildSlug ? parseGuildRouteRef(params.guildSlug) : { guildId: null }),
    [params.guildSlug]
  )

  const activeServer = React.useMemo<Server | null>(() => {
    if (!params.instance || !parsedGuild.guildId) return null
    return (
      servers.find(
        (s) => s.instanceHost === params.instance && s.id === parsedGuild.guildId
      ) ?? null
    )
  }, [servers, params.instance, parsedGuild.guildId])

  const instanceUrl = activeServer?.raw.instanceUrl ?? null
  const token = instanceUrl ? getTokenForInstance(instanceUrl) : null
  const baseUrl = instanceUrl ?? ""
  const wsClient = instanceUrl ? getWsClient(instanceUrl) : null
  const currentUserId = user?.id ?? ""
  // Legacy `connectedInstances[].handshakeData` is kept as the fallback
  // source while the TanStack Query cache (HUSHHQ-18) is the primary
  // truth (HUSHHQ-19). The hook prefers the cache and only reads this
  // mirror when the cache is empty (e.g. mid-disconnect race).
  const activeHandshakeData = React.useMemo(() => {
    if (!instanceUrl) return null
    const activeOrigin = normalizeOrigin(instanceUrl)
    return (
      connectedInstances.find(
        (inst) => normalizeOrigin(inst.instanceUrl) === activeOrigin
      )?.handshakeData ?? null
    )
  }, [connectedInstances, instanceUrl])
  const activeInstanceConfig = useInstanceConfig(instanceUrl, activeHandshakeData)
  const activeMaxAttachmentBytes = readMaxAttachmentBytes(activeInstanceConfig)

  const {
    categories,
    channels,
    systemChannels: systemChannelRows,
    onCategoriesChange,
    onChannelsChange,
    applyCreated: applyChannelCreated,
    applyDeleted: applyChannelsDeleted,
  } = useChannelsForServer({
    serverId: activeServer?.id ?? null,
    token,
    baseUrl,
    currentUserId,
    wsClient: wsClient as Parameters<typeof useChannelsForServer>[0]["wsClient"],
  })

  const sidebarSystemChannels = React.useMemo<SystemChannel[]>(
    () => adaptSystemChannelsForSidebar(systemChannelRows),
    [systemChannelRows]
  )
  const { onlineUserIds, hasSnapshot: hasOnlineSnapshot } =
    useOnlinePresence(
      wsClient as Parameters<typeof useOnlinePresence>[0],
    )
  const { members, refetch: refetchMembers } = useMembersForServer({
    serverId: activeServer?.id ?? null,
    token,
    baseUrl,
    currentUserId,
    onlineUserIds,
    hasOnlineSnapshot,
  })

  // Cross-cutting realtime listeners are mounted PER connected
  // instance and PER server via the realtime shells below. Active-
  // server-only mounting (the previous shape) silently lost
  // moderation events, MLS commits, transparency reverifications,
  // and instance bans for any server / instance the user wasn't
  // currently looking at. The shells delegate to the same hooks
  // (`useTextChannelMLSCommitListener`,
  // `useTransparencyVerification`, `useServerModerationEvents`,
  // `useTextChannelMLSSubscriptions`) but at the right scope.
  const identityPublicKey = identityKeyRef.current?.publicKey ?? null

  // Self kick/ban handler. The shell already toasts; this handler
  // also tears down persisted voice for the exact removed server
  // instance so voice membership follows server membership.
  const joinedVoiceRef = React.useRef<JoinedVoice | null>(null)
  const handleVoiceLeaveRef = React.useRef<(() => void) | null>(null)
  const handleSelfRemovedFromServer = React.useCallback(
    (info: { instanceUrl: string; serverId: string }) => {
      if (
        activeServer &&
        activeServer.id === info.serverId &&
        activeServer.raw.instanceUrl === info.instanceUrl
      ) {
        navigate("/home")
      }
      if (shouldLeaveVoiceAfterSelfRemoval(info, joinedVoiceRef.current)) {
        try {
          handleVoiceLeaveRef.current?.()
        } catch (err) {
          console.warn("[authenticated-app] voice leave after self-removal failed:", err)
        }
      }
    },
    [activeServer, navigate],
  )

  const handleInstanceBanned = React.useCallback(
    (bannedInstanceUrl: string) => {
      // Server-side ban from one instance must NOT trigger
      // performLogout, that would scorched-earth the entire local
      // profile (auth + vault + transcript + MLS + caches) and drop
      // unrelated authenticated instance sessions. Disconnect only
      // the offending instance; if it was active, defer-navigate so
      // the suspension toast remains visible.
      runInstanceBanAction({
        activeInstanceUrl: instanceUrl,
        bannedInstanceUrl,
        disconnectInstance,
        navigate,
      })
    },
    [instanceUrl, navigate, disconnectInstance],
  )

  // Resolve a server name from the merged guild list when the
  // affected server is not the active one (so the toast is still
  // specific instead of "the server").
  const lookupServerNameById = React.useCallback(
    (id: string): string | undefined => {
      const match = servers.find((s) => s.id === id)
      return match?.name
    },
    [servers],
  )

  const voicePresence = useVoiceChannelPresence(
    (instanceUrl ? getWsClient(instanceUrl) : null) as Parameters<
      typeof useVoiceChannelPresence
    >[0],
    currentUserId,
    token,
    activeServer?.id ?? null,
    baseUrl
  )

  const currentUserRole = React.useMemo(
    () => members.find((m) => m.id === currentUserId)?.role,
    [members, currentUserId]
  )

  const handleKickMember = React.useCallback(
    async (member: ServerMember, reason: string) => {
      if (!activeServer || !token) return
      try {
        await kickUser(token, activeServer.id, member.id, reason, baseUrl)
        await refetchMembers()
      } catch (err) {
        console.error("kickUser failed", err)
        throw err
      }
    },
    [activeServer, token, baseUrl, refetchMembers]
  )

  const canAdministrate =
    currentUserRole === "owner" || currentUserRole === "admin"

  // Backend mints text/voice/category through the same endpoint with `type`
  // discriminator. Categories never carry a parentId; channels can be nested
  // under a category by passing it.
  const handleCreateChannel = React.useCallback(
    async (
      kind: "text" | "voice" | "category",
      name: string,
      parentId?: string | null
    ) => {
      if (!activeServer || !token) return
      const body =
        kind === "category" || parentId == null
          ? { name, type: kind }
          : { name, type: kind, parentId }
      // Optimistic local insert from the HTTP response keeps the UI
      // responsive even if the matching `channel_created` WS broadcast
      // is delayed or dropped (flaky WS, missed subscription, etc.).
      // The WS handler dedupes by id when the broadcast lands, so
      // applying twice is a no-op.
      const created = (await createGuildChannel(
        token,
        activeServer.id,
        body,
        baseUrl
      )) as Parameters<typeof applyChannelCreated>[0] | null | undefined
      if (created?.id) {
        applyChannelCreated(created)
      }
    },
    [activeServer, token, baseUrl, applyChannelCreated]
  )

  // Tracks the currently-viewed channel id and the navigateToServer
  // function for callbacks that fire before those bindings are in
  // scope (handleDeleteChannel is declared early in the component
  // body). Both refs are updated by effects further down.
  const activeChannelIdRef = React.useRef<string>("")
  const navigateToServerRef = React.useRef<
    ((server: Server, channelId?: string) => void) | null
  >(null)
  const handleDeleteChannel = React.useCallback(
    async (channelId: string) => {
      if (!activeServer || !token) return
      const deleted = (await deleteGuildChannel(
        token,
        activeServer.id,
        channelId,
        baseUrl
      )) as { deletedChannelIds?: string[] } | null | undefined
      // Optimistic local removal; WS `channel_deleted` reconciliation
      // is idempotent (filter is a no-op when the id is already gone).
      // Recursive category deletes return every cascaded channel id;
      // single-channel deletes return just the requested id (or
      // nothing, the call site falls back to the requested id).
      const ids =
        Array.isArray(deleted?.deletedChannelIds) &&
        deleted!.deletedChannelIds!.length > 0
          ? deleted!.deletedChannelIds!
          : [channelId]
      applyChannelsDeleted(ids)
      // Drop any stale reference to the deleted channel(s) locally -
      // the active voice session and the chat surface must not stay
      // mounted on a dead id.
      const idSet = new Set(ids)
      setJoinedVoice((prev) =>
        prev && idSet.has(prev.channelId) ? null : prev
      )
      if (idSet.has(activeChannelIdRef.current)) {
        navigateToServerRef.current?.(activeServer)
      }
    },
    [activeServer, token, baseUrl, applyChannelsDeleted]
  )

  const activeServerTarget = React.useMemo<ServerActionTarget | null>(
    () =>
      activeServer
        ? { id: activeServer.id, instanceUrl: activeServer.raw.instanceUrl }
        : null,
    [activeServer]
  )

  // Rituals fork: no Leave or Delete server here. People leave a space by
  // leaving the shared task in Rituals; Rituals removes them (signed sync)
  // and owns the space's lifecycle.

  // Role resolution per server: prefer the active server's full member list
  // (richest data), then the role propagated on the guild-list payload
  // (`permissionLevel` int or `ownerId === currentUserId`). Servers we have
  // no signal for return undefined; callers must treat that as "unknown",
  // not "member".
  //
  // The active-server fallback MUST match on both `id` and `instanceUrl`;
  // otherwise a foreign-instance server with a colliding id would inherit
  // the active server's role (e.g. "owner") and unlock destructive
  // actions on the wrong instance.
  const getServerRole = React.useCallback(
    (target: ServerActionTarget): MemberRole | undefined => {
      if (
        currentUserRole &&
        serverTargetsMatch(activeServerTarget, target)
      ) {
        return currentUserRole
      }
      return resolveServerForAction(servers, target)?.role
    },
    [activeServerTarget, currentUserRole, servers]
  )

  const handleDirectMessage = React.useCallback(
    async (member: ServerMember) => {
      if (!activeServer || !token || !instanceUrl) return
      try {
        const dm = (await createOrFindDM(token, member.id, baseUrl)) as {
          id: string
          channelId: string
        }
        await refreshGuilds(instanceUrl)
        const host = activeServer.instanceHost ?? new URL(instanceUrl).host
        // Rituals fork: neutral slugs only; names never go in a URL path.
        const guildRouteRef = buildGuildRouteRef("dm", dm.id)
        navigate(`/${host}/${guildRouteRef}/${dm.channelId}`)
      } catch (err) {
        console.error("createOrFindDM failed", err)
      }
    },
    [activeServer, token, baseUrl, instanceUrl, refreshGuilds, navigate]
  )

  // Rituals fork: no Create invite, no Create server and no desktop update
  // check (see the note at the top of this file).

  const allChannels = React.useMemo(
    (): ShellChannel[] => [
      ...systemChannelRows.map((c) => ({
        id: c.id,
        name: c.name,
        kind: "system" as const,
      })),
      ...channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    ],
    [systemChannelRows, channels]
  )

  // Fallback chain: exact slug match → first read-only system channel
  // (real backend id) → first text/voice → blank stub. A newly opened
  // server must never mount Chat on an unknown placeholder.
  const activeChannel = React.useMemo<ShellChannel>(() => {
    const match = allChannels.find((c) => c.id === params.channelSlug)
    if (match) return match
    const firstSystem = systemChannelRows[0]
    if (firstSystem) {
      return { id: firstSystem.id, name: firstSystem.name, kind: "system" }
    }
    const firstChannel = channels[0]
    if (firstChannel) {
      return {
        id: firstChannel.id,
        name: firstChannel.name,
        kind: firstChannel.kind,
      }
    }
    return { id: "", name: "Channel", kind: "text" }
  }, [allChannels, channels, params.channelSlug, systemChannelRows])

  // Mirror activeChannel.id into the ref so handleDeleteChannel
  // (declared earlier for hooks-order reasons) can read the current
  // value at delete time.
  React.useEffect(() => {
    activeChannelIdRef.current = activeChannel.id
  }, [activeChannel.id])

  const activeSystemChannelType = React.useMemo<SystemChannelType | null>(
    () =>
      activeChannel.kind === "system"
        ? systemChannelRows.find((c) => c.id === activeChannel.id)
            ?.systemChannelType ?? "server-log"
        : null,
    [activeChannel, systemChannelRows]
  )

  // Voice state, populated by <VoiceChannelView /> via onVoiceStateChange.
  // joinedVoice holds the active voice channel descriptor; mount/unmount of
  // <VoiceChannelView /> drives connect/disconnect.
  const [joinedVoice, setJoinedVoice] = React.useState<JoinedVoice | null>(null)
  React.useEffect(() => {
    joinedVoiceRef.current = joinedVoice
  }, [joinedVoice])
  // Channel id the user just hung up on. Suppresses the auto-rejoin
  // effect so leaving lands on the placeholder lobby rather than
  // immediately reconnecting. Cleared when the user navigates away
  // from voice routes or clicks "Join call" in the placeholder.
  const [voluntarilyLeftChannelId, setVoluntarilyLeftChannelId] =
    React.useState<string | null>(null)
  const [voiceState, setVoiceState] = React.useState({
    isMicOn: false,
    isDeafened: false,
    isScreenSharing: false,
    isWebcamOn: false,
  })
  const isMuted = !voiceState.isMicOn
  const isDeafened = voiceState.isDeafened
  const isVideoOn = voiceState.isWebcamOn
  const isScreenSharing = voiceState.isScreenSharing
  const voiceControlsRef = React.useRef<VoiceControls>({})
  const handleVoiceStateChange = React.useCallback(
    (next: VoiceState) => {
      setVoiceState(next)
    },
    []
  )
  const [isCommandOpen, setIsCommandOpen] = React.useState(false)
  const [isCheatSheetOpen, setIsCheatSheetOpen] = React.useState(false)
  const [isUserSettingsOpen, setIsUserSettingsOpen] = React.useState(false)
  // Rituals fork: settings can open straight on a section (the recovery
  // phrase reminder opens "Recovery phrase").
  const [userSettingsSection, setUserSettingsSection] = React.useState<
    string | undefined
  >(undefined)
  const openUserSettings = React.useCallback((sectionId?: string) => {
    setUserSettingsSection(sectionId)
    setIsUserSettingsOpen(true)
  }, [])

  // Rituals fork: the page title names the open space, and the native
  // Rituals app (in-app web view) hears when the space is shown and what
  // it is called. A space with no readable name falls back to its id in
  // the adapter, which is never sent as a title.
  const activeSpaceName =
    activeServer && activeServer.name && activeServer.name !== activeServer.id
      ? activeServer.name.trim()
      : ""
  React.useEffect(() => {
    document.title = activeSpaceName ? `${activeSpaceName} · Rituals` : "Rituals Space"
  }, [activeSpaceName])
  const hostReadyPostedRef = React.useRef(false)
  React.useEffect(() => {
    if (!activeServer || hostReadyPostedRef.current) return
    hostReadyPostedRef.current = true
    postToRitualsHost({ type: "ready" })
  }, [activeServer])
  React.useEffect(() => {
    if (activeSpaceName) postToRitualsHost({ type: "title", title: activeSpaceName })
  }, [activeSpaceName])
  const [favorites, setFavorites] = React.useState<FavoriteEntry[]>([])
  const favoriteIds = React.useMemo(
    () => new Set(favorites.map((f) => f.messageId)),
    [favorites]
  )

  const railEntries = React.useMemo(
    () => [{ id: "home", name: "Home", initials: "HO" }, ...servers],
    [servers]
  )

  // DMs (isDm guilds) surfaced separately from regular servers in HomeSidebar.
  // Click navigates to the DM guild's text channel via the standard route.
  // Presence comes from the WS-driven online set so the dot reflects
  // the peer's connection state in realtime.
  const homeDMs = React.useMemo(
    () =>
      dmGuilds
        .filter((g) => g.channelId)
        .map((g) => {
          const name = formatUserLabel({
            displayName: g.otherUser?.displayName,
            username: g.otherUser?.username,
            fallback: "user",
          })
          const peerId = g.otherUser?.id
          // Presence stays optimistic ("online") until the first
          // `presence.update` frame so the DM list does not flicker
          // every peer to "offline" on initial mount.
          const presence: "online" | "offline" = !hasOnlineSnapshot
            ? "online"
            : peerId && onlineUserIds.has(peerId)
              ? "online"
              : "offline"
          return {
            id: g.channelId as string,
            name,
            initials: deriveInitials(name),
            presence,
          }
        }),
    [dmGuilds, onlineUserIds, hasOnlineSnapshot]
  )

  const handleSelectHomeDM = React.useCallback(
    (channelId: string) => {
      const dm = dmGuilds.find((g) => g.channelId === channelId)
      if (!dm?.instanceUrl) {
        navigate(`/home/${channelId}`)
        return
      }
      const host = new URL(dm.instanceUrl).host
      // Rituals fork: neutral slug (no person's name in the URL path).
      const ref = buildGuildRouteRef("dm", dm.id)
      navigate(`/${host}/${ref}/${channelId}`)
    },
    [dmGuilds, navigate]
  )

  const navigateToServer = React.useCallback(
    (server: Server, channelId?: string) => {
      if (!server.instanceHost) return
      // Rituals fork: a neutral slug. A space is named after its task, and
      // the path reaches the host's access logs on every reload.
      const ref = buildGuildRouteRef("space", server.id)
      navigate(channelId ? `/${server.instanceHost}/${ref}/${channelId}` : `/${server.instanceHost}/${ref}`)
    },
    [navigate]
  )
  React.useEffect(() => {
    navigateToServerRef.current = navigateToServer
  }, [navigateToServer])

  const handleSelectRail = React.useCallback(
    (target: RailSelection | string) => {
      if (target === "home") {
        navigate("/home")
        return
      }
      const server =
        typeof target === "string"
          ? servers.find((s) => s.id === target)
          : resolveServerForAction(servers, target)
      if (server) navigateToServer(server)
    },
    [navigate, navigateToServer, servers]
  )

  const handleSelectChannel = React.useCallback(
    (id: string) => {
      if (!activeServer) return
      const channel = allChannels.find((c) => c.id === id)
      if (channel?.kind === "voice" && instanceUrl) {
        setJoinedVoice({
          channelId: id,
          channelName: channel.name,
          serverId: activeServer.id,
          serverName: activeServer.name,
          instanceUrl,
        })
      }
      navigateToServer(activeServer, id)
    },
    [activeServer, allChannels, navigateToServer, instanceUrl]
  )

  // Auto-redirect when no channel slug in URL (server view).
  // Mirrors activeChannel fallback: first system channel, then first
  // regular channel. Without this, navigating to channels[0] would
  // bypass the system-channel-first preference and land on a normal
  // text/voice channel even when system rows exist.
  React.useEffect(() => {
    if (!activeServer || params.channelSlug) return
    const firstSystem = systemChannelRows[0]
    if (firstSystem) {
      navigateToServer(activeServer, firstSystem.id)
      return
    }
    const first = channels[0]
    if (first) navigateToServer(activeServer, first.id)
  }, [activeServer, params.channelSlug, channels, systemChannelRows, navigateToServer])

  // Auto-join LiveKit when the URL points at a voice channel. The user
  // expectation is that opening a voice channel, by sidebar click, deep
  // link, refresh, or rail navigation, joins the room immediately, the
  // same way legacy hush-web behaved. No prejoin step. handleSelectChannel
  // already sets joinedVoice on click; this effect covers the deep-link /
  // refresh path where the sidebar handler never fired.
  React.useEffect(() => {
    if (!activeServer || !instanceUrl) return
    if (activeChannel.kind !== "voice") return
    if (joinedVoice && joinedVoice.channelId === activeChannel.id) return
    if (voluntarilyLeftChannelId === activeChannel.id) return
    setJoinedVoice({
      channelId: activeChannel.id,
      channelName: activeChannel.name,
      serverId: activeServer.id,
      serverName: activeServer.name,
      instanceUrl,
    })
  }, [activeServer, activeChannel, instanceUrl, joinedVoice, voluntarilyLeftChannelId])

  // Clear the voluntary-leave guard whenever the user moves off the
  // voice channel route, next time they come back it should auto-join.
  React.useEffect(() => {
    if (activeChannel.kind !== "voice") {
      if (voluntarilyLeftChannelId) setVoluntarilyLeftChannelId(null)
      return
    }
    if (
      voluntarilyLeftChannelId != null &&
      voluntarilyLeftChannelId !== activeChannel.id
    ) {
      setVoluntarilyLeftChannelId(null)
    }
  }, [activeChannel.kind, activeChannel.id, voluntarilyLeftChannelId])

  // Default to Catch-up surface when on /home with no channel slug
  React.useEffect(() => {
    if (activeServer || params.channelSlug) return
    if (params.instance || params.guildSlug) return
    navigate("/home/catch-up", { replace: true })
  }, [activeServer, params.channelSlug, params.instance, params.guildSlug, navigate])

  const handleToggleMute = React.useCallback(() => {
    voiceControlsRef.current.toggleMic?.()
  }, [])

  const handleToggleDeafen = React.useCallback(() => {
    voiceControlsRef.current.toggleDeafen?.()
  }, [])

  // Voice runtime surface for the settings panel: lets the mic-test
  // card temporarily deafen the room while monitoring locally, and
  // pushes filter changes (noise gate threshold) into the live capture
  // graph without the user having to leave + rejoin the channel.
  const isInVoice = joinedVoice != null
  const voiceRuntime = React.useMemo(
    () => ({
      isInVoice,
      isMuted,
      isDeafened,
      onMute: () => {
        voiceControlsRef.current.toggleMic?.()
      },
      onDeafen: () => {
        voiceControlsRef.current.toggleDeafen?.()
      },
      onMicFilterSettingsChange: (settings: Partial<{
        noiseGateEnabled: boolean
        noiseGateThresholdDb: number
      }>) => {
        voiceControlsRef.current.applyMicFilterSettings?.(settings)
      },
      onOutputDeviceChange: (deviceId: string | null) => {
        return voiceControlsRef.current.setOutputDeviceSink?.(deviceId)
      },
    }),
    [isInVoice, isMuted, isDeafened]
  )

  const handleToggleVideo = React.useCallback(() => {
    voiceControlsRef.current.toggleWebcam?.()
  }, [])

  const handleToggleScreen = React.useCallback(() => {
    voiceControlsRef.current.toggleScreenShare?.()
  }, [])

  const handleVoiceLeave = React.useCallback(() => {
    setVoluntarilyLeftChannelId(joinedVoice?.channelId ?? null)
    setJoinedVoice(null)
    setVoiceState({
      isMicOn: false,
      isDeafened: false,
      isScreenSharing: false,
      isWebcamOn: false,
    })
  }, [joinedVoice?.channelId])
  React.useEffect(() => {
    handleVoiceLeaveRef.current = handleVoiceLeave
  }, [handleVoiceLeave])

  const handleJoinFromPlaceholder = React.useCallback(() => {
    if (!activeServer || !instanceUrl) return
    if (activeChannel.kind !== "voice") return
    setVoluntarilyLeftChannelId(null)
    setJoinedVoice({
      channelId: activeChannel.id,
      channelName: activeChannel.name,
      serverId: activeServer.id,
      serverName: activeServer.name,
      instanceUrl,
    })
  }, [activeServer, activeChannel, instanceUrl])

  // Augment voice-channel rows with their live participant rosters so
  // the sidebar surfaces the live presence stack the mockup
  // demonstrates. Two sources merged:
  // - WS-driven `voicePresence` (other users via voice_state_update)
  // - local `joinedVoice` (self), guarantees the user always sees
  //   their own avatar the moment they connect, without waiting for
  //   the LiveKit webhook round-trip.
  const channelsWithVoicePresence = React.useMemo<Channel[]>(() => {
    const myChannelId = joinedVoice?.channelId ?? null
    if (voicePresence.size === 0 && myChannelId == null) return channels
    const myDisplayName =
      sanitizeDisplayName(getUserDisplayName(user), user?.username) ||
      user?.username?.trim() ||
      "You"
    const myInitials = (() => {
      const parts = myDisplayName.split(/\s+/).filter(Boolean)
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
      return parts[0]?.[0]?.toUpperCase() ?? "?"
    })()
    return channels.map((c) => {
      if (c.kind !== "voice") return c
      const fromWs = voicePresence.get(c.id) ?? []
      const isJoinedHere = myChannelId === c.id
      const hasSelf = fromWs.some((p) => p.id === currentUserId)
      // Local-state overrides for the current user's row keep the
      // own mute/deafen badges responsive (no wait for the WS echo
      // of voice.mute_state). Applied whether the self row was
      // injected by us (no roster yet) or already arrived via
      // voice_state_update.
      const selfOverrides = isJoinedHere && currentUserId
        ? {
            isMuted: !voiceState.isMicOn,
            isDeafened: voiceState.isDeafened,
          }
        : null
      let merged: VoiceParticipantInfo[] = fromWs
      if (isJoinedHere && !hasSelf && currentUserId) {
        merged = [
          ...fromWs,
          {
            id: currentUserId,
            name: "You",
            initials: myInitials,
            ...(selfOverrides ?? {}),
          },
        ]
      } else if (selfOverrides) {
        merged = fromWs.map((p) =>
          p.id === currentUserId ? { ...p, ...selfOverrides } : p,
        )
      }
      return merged.length > 0 ? { ...c, participants: merged } : c
    })
  }, [
    channels,
    voicePresence,
    joinedVoice?.channelId,
    currentUserId,
    user?.displayName,
    user?.display_name,
    user?.username,
    voiceState.isMicOn,
    voiceState.isDeafened,
  ])

  const isViewingVoice =
    joinedVoice != null && activeChannel.id === joinedVoice.channelId
  const isVoiceChannelActive = activeChannel.kind === "voice"
  const showVoicePlaceholder = isVoiceChannelActive && !isViewingVoice
  const joinedVoiceInstanceUrl = joinedVoice?.instanceUrl ?? null
  // Voice connection lives on the joined-voice instance, not the
  // currently-navigated channel's instance. When the user navigates to
  // another instance while in voice, the VoiceChannel mount must keep
  // talking to the original instance's wsClient + token. Otherwise the
  // MLS voice group / WebSocket diverges from the active session.
  const voiceToken = joinedVoiceInstanceUrl
    ? getTokenForInstance(joinedVoiceInstanceUrl)
    : null
  const voiceWsClient = joinedVoiceInstanceUrl
    ? getWsClient(joinedVoiceInstanceUrl)
    : null
  // Same migration pattern as the active-server config above: the
  // TanStack Query cache is primary; the legacy `handshakeData` mirror
  // remains as a fallback for the brief mid-disconnect window.
  const voiceHandshakeData = React.useMemo(() => {
    if (!joinedVoiceInstanceUrl) return null
    const joinedOrigin = normalizeOrigin(joinedVoiceInstanceUrl)
    return (
      connectedInstances.find(
        (inst) => normalizeOrigin(inst.instanceUrl) === joinedOrigin
      )?.handshakeData ?? null
    )
  }, [connectedInstances, joinedVoiceInstanceUrl])
  const voiceInstanceConfig = useInstanceConfig(
    joinedVoiceInstanceUrl,
    voiceHandshakeData
  )
  const voiceScreenShareResolutionCap =
    readScreenShareResolutionCap(voiceInstanceConfig)
  const voiceGetToken = React.useCallback(
    () => voiceToken,
    [voiceToken]
  )

  const handleJumpToVoice = React.useCallback(() => {
    if (!joinedVoice) return
    const server = servers.find((s) => s.id === joinedVoice.serverId)
    if (server) navigateToServer(server, joinedVoice.channelId)
  }, [joinedVoice, navigateToServer, servers])

  const handleAddFavorite = React.useCallback(
    (entry: Omit<FavoriteEntry, "id" | "savedAt">) => {
      setFavorites((prev) => {
        if (prev.some((f) => f.messageId === entry.messageId)) return prev
        return [
          { ...entry, id: `fav-${entry.messageId}`, savedAt: Date.now() },
          ...prev,
        ]
      })
    },
    []
  )

  const handleRemoveFavorite = React.useCallback((messageId: string) => {
    setFavorites((prev) => prev.filter((f) => f.messageId !== messageId))
  }, [])

  const handleJumpToFavorite = React.useCallback(
    (entry: FavoriteEntry) => {
      const server = servers.find((s) => s.id === entry.serverId)
      if (server) navigateToServer(server, entry.channelId)
    },
    [navigateToServer, servers]
  )

  // Keyboard shortcuts
  React.useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return true
      if (target.isContentEditable) return true
      return false
    }

    function handleKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key
      const editable = isEditableTarget(event.target)

      if (mod && key.toLowerCase() === "k") {
        event.preventDefault()
        setIsCommandOpen((prev) => !prev)
        return
      }
      if (mod && (key === "/" || (event.shiftKey && key === "?"))) {
        event.preventDefault()
        setIsCheatSheetOpen((prev) => !prev)
        return
      }
      if (mod && /^[1-9]$/.test(key) && !embedded) {
        event.preventDefault()
        const idx = Number(key) - 1
        const target = railEntries[idx]
        if (target) {
          handleSelectRail(
            target.id === "home" || !("raw" in target)
              ? target.id
              : { id: target.id, instanceUrl: target.raw.instanceUrl }
          )
        }
        return
      }
      if (mod && event.shiftKey && key.toLowerCase() === "m") {
        if (!joinedVoice) return
        event.preventDefault()
        handleToggleMute()
        return
      }
      if (mod && event.shiftKey && key.toLowerCase() === "d") {
        if (!joinedVoice) return
        event.preventDefault()
        handleToggleDeafen()
        return
      }
      if (key === "Escape" && !editable && !mod && !event.altKey) {
        return
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    joinedVoice,
    railEntries,
    handleSelectRail,
    handleToggleMute,
    handleToggleDeafen,
    embedded,
  ])

  // Bridge: the desktop topbar omnibar dispatches a window-level event to
  // open this palette without coupling to its React state. Mirrors the
  // existing Cmd/Ctrl+K handler above.
  React.useEffect(() => {
    function handleOpenPalette() {
      setIsCommandOpen(true)
    }
    window.addEventListener("hush:open-command-palette", handleOpenPalette)
    return () =>
      window.removeEventListener("hush:open-command-palette", handleOpenPalette)
  }, [])

  // Channel palette: only the active server has its channel list fetched
  // (useChannelsForServer keys on activeServer.id). Earlier this code
  // flat-mapped every server across the same active-server channel list,
  // producing a cartesian product where each server appeared with channels
  // it does not own. Restrict to active server's channels until per-server
  // pre-fetch lands.
  const paletteChannels = React.useMemo(
    () =>
      activeServer
        ? channels.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            serverId: activeServer.id,
            serverName: activeServer.name,
          }))
        : [],
    [activeServer, channels]
  )

  const voiceProps = joinedVoice
    ? {
        channelName: joinedVoice.channelName,
        serverName: joinedVoice.serverName,
        isMuted,
        isDeafened,
        isVideoOn,
        isScreenSharing,
        onToggleMute: handleToggleMute,
        onToggleDeafen: handleToggleDeafen,
        onToggleVideo: handleToggleVideo,
        onToggleScreen: handleToggleScreen,
        onDisconnect: handleVoiceLeave,
        onJump: handleJumpToVoice,
      }
    : undefined

  // Sidebar user prop (prototype shape). `name` is the display
  // name only; `username` stays undecorated and is rendered as a
  // handle only by the user-menu presentation layer.
  const sidebarUser = React.useMemo(() => {
    const display = sanitizeDisplayName(getUserDisplayName(user), user?.username)
    const username = formatUserLabel({ username: user?.username, fallback: "" })
    return {
      name: display || "You",
      username,
      initials: deriveInitials(display || username || "you"),
    }
  }, [user?.displayName, user?.display_name, user?.username])

  // Stable Chat.jsx prop callbacks
  const getStore = React.useCallback(
    () => mlsStore.openStore(currentUserId, getDeviceId()),
    [currentUserId]
  )
  const getHistoryStore = React.useCallback(
    () => mlsStore.openHistoryStore(currentUserId, getDeviceId()),
    [currentUserId]
  )
  const getToken = React.useCallback(
    () => (instanceUrl ? getTokenForInstance(instanceUrl) : null),
    [instanceUrl, getTokenForInstance]
  )

  // Build message body for current channel.
  const isHomeSurface = !activeServer
  const isCatchUp = isHomeSurface && params.channelSlug === "catch-up"
  const isFavoritesSurface = isHomeSurface && params.channelSlug === "favorites"

  // System channels are server-side audit/log feeds, never mount the MLS
  // chat over them. SystemChannelView handles their dedicated render.
  const isSystemChannel = activeChannel.kind === "system"
  const chatBody =
    activeServer &&
    activeChannel.kind === "text" &&
    activeChannel.id &&
    !isSystemChannel ? (
      <RealChat
        channelId={activeChannel.id}
        channelName={activeChannel.name}
        serverId={activeServer.id}
        currentUserId={currentUserId}
        getToken={getToken}
        getStore={getStore}
        getHistoryStore={getHistoryStore}
        wsClient={wsClient}
        members={members}
        baseUrl={baseUrl}
        maxAttachmentBytes={activeMaxAttachmentBytes}
        markReadEnabled
      />
    ) : null

  const channelContent = isFavoritesSurface ? (
    <ChannelView
      channelId="favorites"
      channelName="Favorites"
      channelKind="home"
      channelTopic="Messages you saved across servers"
      headerIcon={<StarIcon className="size-5 text-muted-foreground" />}
      messageBody={
        <FavoritesView
          favorites={favorites}
          onJump={handleJumpToFavorite}
          onRemove={handleRemoveFavorite}
        />
      }
    />
  ) : isCatchUp ? (
    <ChannelView
      channelId="catch-up"
      channelName="Catch up"
      channelKind="home"
      channelTopic="Mentions, replies, threads, DMs"
    />
  ) : activeServer && isSystemChannel ? (
    (() => {
      const sysSource = activeSystemChannelType ?? "server-log"
      const sysHeader = SYSTEM_CHANNEL_HEADERS[sysSource]
      return (
        <ChannelView
          channelId={activeChannel.id}
          channelName={sysHeader.title}
          channelKind="text"
          channelTopic={sysHeader.topic}
          channelContext={{
            serverId: activeServer.id,
            serverName: activeServer.name,
          }}
          headerIcon={sysHeader.icon}
          members={members}
          currentUserRole={currentUserRole}
          onKickMember={handleKickMember}
          onDirectMessage={handleDirectMessage}
          messageBody={
            <SystemChannelView
              serverId={activeServer.id}
              source={sysSource}
              token={token}
              baseUrl={baseUrl}
              wsClient={wsClient as Parameters<typeof SystemChannelView>[0]["wsClient"]}
              resolveActorLabel={(id) => resolveActorLabel(members, id)}
            />
          }
        />
      )
    })()
  ) : activeServer ? (
    <ChannelView
      channelId={activeChannel.id}
      channelName={activeChannel.name}
      channelKind={activeChannel.kind === "voice" ? "voice" : "text"}
      channelContext={{
        serverId: activeServer.id,
        serverName: activeServer.name,
      }}
      members={members}
      currentUserRole={currentUserRole}
      onKickMember={handleKickMember}
      onDirectMessage={handleDirectMessage}
      messageBody={chatBody}
      favoriteIds={favoriteIds}
      onAddFavorite={handleAddFavorite}
      onRemoveFavorite={handleRemoveFavorite}
    />
  ) : parsedGuild.guildId &&
    guildsLoaded &&
    !dmGuilds.some((g) => g.id === parsedGuild.guildId) ? (
    // Rituals fork: a space link this identity is not (or no longer) in.
    // Upstream showed an empty "DM" view here; say what happened instead.
    <SpaceUnavailableView />
  ) : (
    <ChannelView
      channelId={params.channelSlug ?? ""}
      channelName="DM"
      channelKind="text"
      channelTopic="Direct message"
    />
  )

  return (
    <TooltipProvider>
      {/* Realtime fanout shells. One mount per connected instance
          (transparency, instance_banned, mls.commit listener) and
          one per (instance, server) pair (text-channel MLS room
          subs + moderation events). Active-server-only mounting
          previously caused the listener to be torn down whenever
          the user navigated away. */}
      {connectedInstances.map((inst) => (
        <React.Fragment key={inst.instanceUrl}>
          <PerInstanceListeners
            instance={inst as Parameters<typeof PerInstanceListeners>[0]["instance"]}
            identityPublicKey={identityPublicKey}
            setTransparencyError={setTransparencyError}
            onInstanceBanned={handleInstanceBanned}
          />
          {inst.serverIds.map((serverId) => {
            const isActive =
              activeServer?.id === serverId &&
              activeServer.raw.instanceUrl === inst.instanceUrl
            return (
              <PerServerListeners
                key={`${inst.instanceUrl}|${serverId}`}
                instanceUrl={inst.instanceUrl}
                wsClient={inst.wsClient as Parameters<typeof PerServerListeners>[0]["wsClient"]}
                token={inst.token}
                currentUserId={inst.userId}
                serverId={serverId}
                serverName={lookupServerNameById(serverId)}
                refetchMembers={isActive ? refetchMembers : noopRefetch}
                onSelfRemoved={handleSelfRemovedFromServer}
              />
            )
          })}
        </React.Fragment>
      ))}
      {embedded ? null : (
        <ServerRail
          servers={railServers}
          activeRailTarget={activeServerTarget ?? "home"}
          onSelect={handleSelectRail}
          getServerRole={getServerRole}
        />
      )}
      <SidebarProvider
        data-desktop-chrome="authenticated-shell"
        className={
          embedded
            ? "h-svh min-h-0! overflow-hidden bg-sidebar"
            : "h-svh min-h-0! overflow-hidden bg-sidebar md:pl-(--rail-width)"
        }
      >
        {isMobile
          ? activeServer
            ? <ChannelSidebar
                serverName={activeServer.name}
                serverPlan="Space"
                systemChannels={sidebarSystemChannels}
                categories={categories}
                channels={channelsWithVoicePresence}
                onCategoriesChange={onCategoriesChange}
                onChannelsChange={onChannelsChange}
                activeChannelId={activeChannel.id}
                onSelectChannel={handleSelectChannel}
                user={sidebarUser}
                railEntries={railEntries}
                activeRailId={activeServer.id}
                onSelectRail={handleSelectRail}
                voice={voiceProps}
                onOpenUserSettings={() => openUserSettings()}
                onOpenRecoveryPhrase={() => openUserSettings("recovery")}
                onSignOut={handleSignOut}
                onCreateChannel={handleCreateChannel}
                onDeleteChannel={handleDeleteChannel}
                onDeleteCategory={handleDeleteChannel}
                canAdministrate={canAdministrate}
              />
            : <HomeSidebar
                user={sidebarUser}
                railEntries={railEntries}
                activeRailId="home"
                onSelectRail={handleSelectRail}
                activeChannelId={params.channelSlug ?? "catch-up"}
                onSelectChannel={(id) => {
                  if (homeDMs.some((d) => d.id === id)) {
                    handleSelectHomeDM(id)
                    return
                  }
                  navigate(`/home/${id}`)
                }}
                voice={voiceProps}
                onOpenUserSettings={() => openUserSettings()}
                onOpenRecoveryPhrase={() => openUserSettings("recovery")}
                onSignOut={handleSignOut}
                directMessages={homeDMs}
              />
          : null}
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full w-full"
        >
          {!isMobile ? (
            <ResizablePanel
              id="shell-sidebar"
              defaultSize="18rem"
              minSize="14rem"
              maxSize="22rem"
            >
              {activeServer ? (
                <ChannelSidebar
                  serverName={activeServer.name}
                  serverPlan="Space"
                  systemChannels={sidebarSystemChannels}
                  categories={categories}
                  channels={channelsWithVoicePresence}
                  onCategoriesChange={onCategoriesChange}
                  onChannelsChange={onChannelsChange}
                  activeChannelId={activeChannel.id}
                  onSelectChannel={handleSelectChannel}
                  user={sidebarUser}
                  railEntries={railEntries}
                  activeRailId={activeServer.id}
                  onSelectRail={handleSelectRail}
                  voice={voiceProps}
                  onOpenUserSettings={() => openUserSettings()}
                  onOpenRecoveryPhrase={() => openUserSettings("recovery")}
                  onSignOut={handleSignOut}
                  onCreateChannel={handleCreateChannel}
                  onDeleteChannel={handleDeleteChannel}
                  onDeleteCategory={handleDeleteChannel}
                  canAdministrate={canAdministrate}
                />
              ) : (
                <HomeSidebar
                  user={sidebarUser}
                  railEntries={railEntries}
                  activeRailId="home"
                  onSelectRail={handleSelectRail}
                  activeChannelId={params.channelSlug ?? "catch-up"}
                  onSelectChannel={(id) => {
                    if (homeDMs.some((d) => d.id === id)) {
                      handleSelectHomeDM(id)
                      return
                    }
                    navigate(`/home/${id}`)
                  }}
                  voice={voiceProps}
                  onOpenUserSettings={() => openUserSettings()}
                  onOpenRecoveryPhrase={() => openUserSettings("recovery")}
                  onSignOut={handleSignOut}
                  directMessages={homeDMs}
                />
              )}
            </ResizablePanel>
          ) : null}
          {!isMobile ? (
            <ResizableHandle className="bg-transparent! focus:outline-none focus-visible:ring-0 data-[resize-handle-active]:bg-transparent! data-[resize-handle-state=hover]:bg-transparent! data-[resize-handle-state=drag]:bg-transparent!" />
          ) : null}
          <ResizablePanel
            id="shell-main"
            minSize="20rem"
            className="flex"
          >
            <SidebarInset className="md:m-2 md:ml-0 md:rounded-xl md:overflow-hidden md:shadow-sm md:mb-0! md:rounded-b-none!">
              {/* Mobile-only sidebar reopen trigger for voice surfaces.
                  ChannelView (text/system channels) renders its own
                  SidebarTrigger inside its header, but VoiceChannelView
                  and VoicePlaceholderView intentionally have no chrome
                  band. Without this floating trigger, a user who lands
                  on a voice route on mobile can't reopen the sidebar
                  short of a hard reload. Hidden on md+ where the
                  sidebar is permanently visible. */}
              {(isViewingVoice || showVoicePlaceholder) ? (
                <SidebarTrigger className="md:hidden absolute top-2 left-2 z-20" />
              ) : null}
              {joinedVoice && joinedVoiceInstanceUrl ? (
                <div
                  style={{
                    display: isViewingVoice ? "flex" : "none",
                    height: "100%",
                    flexDirection: "column",
                  }}
                >
                  <VoiceChannelView
                    key={joinedVoice.channelId}
                    channel={{
                      id: joinedVoice.channelId,
                      name: joinedVoice.channelName,
                      type: "voice",
                    }}
                    serverId={joinedVoice.serverId}
                    getToken={voiceGetToken}
                    wsClient={voiceWsClient}
                    members={
                      activeServer?.id === joinedVoice.serverId ? members : []
                    }
                    myRole={
                      activeServer?.id === joinedVoice.serverId
                        ? currentUserRole ?? "member"
                        : "member"
                    }
                    onLeave={handleVoiceLeave}
                    voiceControlsRef={voiceControlsRef}
                    onVoiceStateChange={handleVoiceStateChange}
                    baseUrl={joinedVoiceInstanceUrl}
                    screenShareResolutionCap={voiceScreenShareResolutionCap}
                  />
                </div>
              ) : null}
              {showVoicePlaceholder ? (
                <VoicePlaceholderView
                  channelName={activeChannel.name}
                  onJoinCall={handleJoinFromPlaceholder}
                />
              ) : null}
              {!isViewingVoice && !showVoicePlaceholder ? channelContent : null}
            </SidebarInset>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarProvider>
      <CommandPalette
        open={isCommandOpen}
        onOpenChange={setIsCommandOpen}
        channels={paletteChannels}
        servers={servers}
        onJumpServer={(id) => {
          const server = servers.find((s) => s.id === id)
          if (server) navigateToServer(server)
        }}
        onJumpChannel={(channel) => {
          const server = servers.find((s) => s.id === channel.serverId)
          if (server) navigateToServer(server, channel.id)
        }}
        onToggleMute={handleToggleMute}
        onGoHome={() => navigate("/home")}
        onOpenCheatSheet={() => setIsCheatSheetOpen(true)}
        onCreateChannel={
          activeServer && canAdministrate
            ? (kind) =>
                window.dispatchEvent(
                  new CustomEvent("hush:open-create-channel", {
                    detail: { kind },
                  })
                )
            : undefined
        }
        onOpenSettings={() => openUserSettings()}
        onSignOut={handleSignOut}
      />
      <CheatSheet open={isCheatSheetOpen} onOpenChange={setIsCheatSheetOpen} />
      <UserSettingsDialog
        open={isUserSettingsOpen}
        onOpenChange={setIsUserSettingsOpen}
        initialSectionId={userSettingsSection}
        account={
          user
            ? {
                displayName: getUserDisplayName(user),
                username: user.username ?? "",
              }
            : undefined
        }
        homeInstanceUrl={homeInstance.url}
        homeLogPublicKey={homeInstance.logPublicKey}
        voiceRuntime={voiceRuntime}
        voicePrefsScope={
          joinedVoiceInstanceUrl ?? instanceUrl ?? homeInstance.url
        }
        onSignOut={async () => {
          await performLogout()
          setIsUserSettingsOpen(false)
        }}
      />
    </TooltipProvider>
  )
}

/**
 * Rituals fork: shown for a space route this identity cannot open (not a
 * member any more, or the link belongs to someone else's device).
 */
function SpaceUnavailableView() {
  const inHost = isEmbedded()
  React.useEffect(() => {
    postToRitualsHost({ type: "error", reason: "not_member" })
  }, [])
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <SidebarTrigger className="absolute top-2 left-2 md:hidden" />
      <RitualsMark className="size-10 text-muted-foreground" />
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="text-lg font-semibold">This space isn&apos;t open here</h2>
        <p className="text-sm text-muted-foreground">
          Open it again from the shared task in Rituals.
        </p>
      </div>
      {inHost ? null : (
        <a
          href={RITUALS_HOME_URL}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          Open Rituals
        </a>
      )}
    </div>
  )
}

interface HomeDM {
  id: string
  name: string
  initials: string
  presence: "online" | "idle" | "dnd" | "offline"
}

function HomeSidebar({
  user,
  railEntries,
  activeRailId,
  onSelectRail,
  activeChannelId,
  onSelectChannel,
  voice,
  onOpenUserSettings,
  onOpenRecoveryPhrase,
  onSignOut,
  directMessages,
}: {
  user: React.ComponentProps<typeof ChannelSidebar>["user"]
  railEntries: { id: string; name: string; initials: string }[]
  activeRailId: string
  onSelectRail: (target: RailSelection | string) => void
  activeChannelId: string
  onSelectChannel: (id: string) => void
  voice?: React.ComponentProps<typeof ChannelSidebar>["voice"]
  onOpenUserSettings?: () => void
  onOpenRecoveryPhrase?: () => void
  onSignOut?: () => void | Promise<void>
  directMessages: HomeDM[]
}) {
  return (
    <ChannelSidebar
      serverName="Home"
      serverPlan="Your spaces and messages"
      systemChannels={HOME_SYSTEM_CHANNELS}
      directMessages={directMessages}
      categories={[] as ChannelCategory[]}
      channels={[] as Channel[]}
      activeChannelId={activeChannelId}
      onSelectChannel={onSelectChannel}
      user={user}
      railEntries={railEntries}
      activeRailId={activeRailId}
      onSelectRail={onSelectRail}
      voice={voice}
      onOpenUserSettings={onOpenUserSettings}
      onOpenRecoveryPhrase={onOpenRecoveryPhrase}
      onSignOut={onSignOut}
      serverMenuEnabled={false}
    />
  )
}

export default AuthenticatedApp
