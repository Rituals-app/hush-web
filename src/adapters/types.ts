/**
 * Adapter types — shared shapes between the prototype UI components and
 * hush-web's real data layer. Adapters in this directory are the *only*
 * place allowed to import both ends, keeping the seam explicit.
 */

export type ChannelKind = "text" | "voice"

export interface VoiceParticipantInfo {
  id: string
  name: string
  initials: string
  isMuted?: boolean
  isDeafened?: boolean
  isSpeaking?: boolean
}

export interface Channel {
  id: string
  name: string
  kind: ChannelKind
  categoryId: string | null
  unreadCount?: number
  mentionCount?: number
  participants?: VoiceParticipantInfo[]
}

export interface ChannelCategory {
  id: string
  name: string
}

/**
 * Backend `type: "system"` channel — server-log / moderation feed.
 * Carries a real backend id (so navigating to it works), plus a
 * `systemChannelType` discriminator the SystemChannelView keys on.
 *
 * Unlike `Channel`, system channels are read-only and have no MLS group;
 * they must never be passed to the chat mount. Keeping them in their own
 * type prevents accidental fanout.
 */
export type SystemChannelType = "server-log" | "moderation"

export interface AdapterSystemChannel {
  id: string
  name: string
  systemChannelType: SystemChannelType
}

export type MemberPresence = "online" | "idle" | "dnd" | "offline"
export type MemberRole = "owner" | "admin" | "moderator" | "member" | "bot"

export interface ServerMember {
  id: string
  /** Best display label: display name, then username, then "user". */
  name: string
  initials: string
  presence?: MemberPresence
  role: MemberRole
  username: string | null
  displayName: string | null
  createdAt: string | null
  joinedAt: string | null
  homeInstance: string | null
  /** Rituals fork: same opaque key on every device of one person in a
   *  Space. Absent elsewhere. */
  personKey?: string | null
}

export interface Server {
  id: string
  name: string
  initials: string
  /** Instance host (URL hostname) — used to build route URLs. */
  instanceHost: string | null
  /**
   * Current user's role on this server, when derivable from the guild list
   * payload alone (`permissionLevel` int or `ownerId === currentUserId`).
   * `undefined` means we don't know yet — caller should fall back to per-server
   * member lookup if it cares (only the active server has full member data).
   */
  role?: MemberRole
  /** Raw guild reference for handlers that need the underlying object. */
  raw: RawGuild
}

export interface RawGuild {
  id: string
  name?: string
  _localName?: string
  instanceUrl: string | null
  ownerId?: string
  permissionLevel?: number
}

/**
 * Map hush-web `permissionLevel` (0-3) → prototype `MemberRole` string.
 * 0=member, 1=moderator, 2=admin, 3=owner.
 */
export function permissionLevelToRole(level: number | undefined): MemberRole {
  if (typeof level !== "number") return "member"
  if (level >= 3) return "owner"
  if (level >= 2) return "admin"
  if (level >= 1) return "moderator"
  return "member"
}

const ROLE_STRING_TO_LEVEL: Record<string, number> = {
  owner: 3,
  admin: 2,
  moderator: 1,
  mod: 1,
  member: 0,
}

/**
 * Resolve a member entry to its prototype MemberRole. Backend `getGuildMembers`
 * may return `permissionLevel` (int 0-3) OR `role` (string). Legacy hush-web
 * supported both via `getMemberLevel`; this mirrors that fallback so the new
 * shell stays compatible with both shapes.
 */
export function memberRoleFromRaw(raw: {
  permissionLevel?: number | null
  role?: string | null
}): MemberRole {
  if (typeof raw.permissionLevel === "number") {
    return permissionLevelToRole(raw.permissionLevel)
  }
  if (typeof raw.role === "string" && raw.role) {
    const role = raw.role.toLowerCase()
    if (role === "bot") return "bot"
    const level = ROLE_STRING_TO_LEVEL[role]
    if (typeof level === "number") return permissionLevelToRole(level)
  }
  return "member"
}

/** Two-letter initials from a display/user name. Empty string returns "?". */
export function deriveInitials(name: string): string {
  const trimmed = (name ?? "").trim().replace(/^@+/, "")
  if (!trimmed) return "?"
  const parts = trimmed.split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?"
}

export function instanceHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
