/**
 * Rituals fork (2026-11-05): one person, several devices.
 *
 * In a Rituals Space each device has its own account, and the server tags
 * every device of one person with the same opaque `personKey`. These helpers
 * make those rows read as one person. Rows without a key (any other server,
 * or an older server) pass through unchanged.
 */
import type { MemberRole, ServerMember, VoiceParticipantInfo } from "@/adapters/types"

const ROLE_RANK: Record<MemberRole, number> = {
  bot: 0,
  member: 1,
  moderator: 2,
  admin: 3,
  owner: 4,
}

/** Latest joinedAt first (rows without one last), then id. */
function latestFirst(a: ServerMember, b: ServerMember): number {
  const at = a.joinedAt ?? ""
  const bt = b.joinedAt ?? ""
  if (at !== bt) {
    if (!at) return 1
    if (!bt) return -1
    return at > bt ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function groupByPerson(members: ServerMember[]): Map<string, ServerMember[]> {
  const groups = new Map<string, ServerMember[]>()
  for (const m of members) {
    if (!m.personKey) continue
    const list = groups.get(m.personKey)
    if (list) list.push(m)
    else groups.set(m.personKey, [m])
  }
  return groups
}

/**
 * Every row of a person takes the name of that person's latest-joined
 * device that has a display name (so a rename shows up), with no username
 * (the per-device handle suffix is not shown), and is online when any of
 * the devices is online. Order and count are kept, so per-device lookups
 * by id still work.
 */
export function unifyPeople(members: ServerMember[]): ServerMember[] {
  const groups = groupByPerson(members)
  if (groups.size === 0) return members
  const shared = new Map<string, Pick<ServerMember, "name" | "initials" | "displayName" | "presence">>()
  for (const [key, list] of groups) {
    const sorted = [...list].sort(latestFirst)
    const named = sorted.find((m) => m.displayName) ?? sorted[0]
    const presence = list.some((m) => m.presence === "online")
      ? "online"
      : named.presence
    shared.set(key, {
      name: named.name,
      initials: named.initials,
      displayName: named.displayName,
      presence,
    })
  }
  return members.map((m) => {
    const s = m.personKey ? shared.get(m.personKey) : undefined
    return s ? { ...m, ...s, username: null } : m
  })
}

/**
 * One row per person for lists and counts, at the person's first position
 * in list order. My own person is this device's row with this device's
 * role (it matches what this device may do). For other people the row is
 * an online device if any (latest joined first), else the latest-joined
 * device, so Message and other actions reach a live device; it shows the
 * highest role among the person's devices.
 */
export function onePerPerson(
  members: ServerMember[],
  currentUserId: string | null
): ServerMember[] {
  const groups = groupByPerson(members)
  if (groups.size === 0) return members
  const emitted = new Set<string>()
  const out: ServerMember[] = []
  for (const m of members) {
    if (!m.personKey) {
      out.push(m)
      continue
    }
    if (emitted.has(m.personKey)) continue
    emitted.add(m.personKey)
    const list = groups.get(m.personKey) ?? [m]
    const mine = list.find((x) => x.id === currentUserId)
    if (mine) {
      out.push(mine)
      continue
    }
    const sorted = [...list].sort(latestFirst)
    const target = sorted.find((x) => x.presence === "online") ?? sorted[0]
    const role = list.reduce(
      (best, x) => (ROLE_RANK[x.role] > ROLE_RANK[best] ? x.role : best),
      target.role
    )
    out.push({ ...target, role })
  }
  return out
}

/**
 * Voice participants with one entry per person: a second device of the
 * same person in the same channel is dropped (this device's own entry is
 * kept), and names follow the unified member rows.
 */
export function onePersonPerVoiceSlot(
  participants: VoiceParticipantInfo[],
  members: ServerMember[],
  currentUserId: string | null
): VoiceParticipantInfo[] {
  const byId = new Map<string, ServerMember>()
  for (const m of members) if (m.personKey) byId.set(m.id, m)
  if (byId.size === 0) return participants
  const ordered = currentUserId
    ? [
        ...participants.filter((p) => p.id === currentUserId),
        ...participants.filter((p) => p.id !== currentUserId),
      ]
    : participants
  const seen = new Set<string>()
  const keep = new Set<VoiceParticipantInfo>()
  for (const p of ordered) {
    const key = byId.get(p.id)?.personKey
    if (!key) {
      keep.add(p)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    keep.add(p)
  }
  return participants
    .filter((p) => keep.has(p))
    .map((p) => {
      const m = byId.get(p.id)
      // The local "You" row keeps its label.
      if (!m || (p.id === currentUserId && p.name === "You")) return p
      return { ...p, name: m.name, initials: m.initials }
    })
}
