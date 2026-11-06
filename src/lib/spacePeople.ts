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

function canonicalFirst(a: ServerMember, b: ServerMember): number {
  const at = a.joinedAt ?? ""
  const bt = b.joinedAt ?? ""
  if (at !== bt) {
    if (!at) return 1
    if (!bt) return -1
    return at < bt ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Every row of a person takes the name of that person's first device
 * that has a display name (earliest joinedAt, then id), with no username (the per-device handle
 * suffix is not shown), and is online when any of the devices is online.
 * Order and count are kept, so per-device lookups by id still work.
 */
export function unifyPeople(members: ServerMember[]): ServerMember[] {
  const groups = new Map<string, ServerMember[]>()
  for (const m of members) {
    if (!m.personKey) continue
    const list = groups.get(m.personKey)
    if (list) list.push(m)
    else groups.set(m.personKey, [m])
  }
  if (groups.size === 0) return members
  const shared = new Map<string, Pick<ServerMember, "name" | "initials" | "displayName" | "presence">>()
  for (const [key, list] of groups) {
    const sorted = [...list].sort(canonicalFirst)
    const canonical = sorted.find((m) => m.displayName) ?? sorted[0]
    const presence = list.some((m) => m.presence === "online")
      ? "online"
      : canonical.presence
    shared.set(key, {
      name: canonical.name,
      initials: canonical.initials,
      displayName: canonical.displayName,
      presence,
    })
  }
  return members.map((m) => {
    const s = m.personKey ? shared.get(m.personKey) : undefined
    return s ? { ...m, ...s, username: null } : m
  })
}

/**
 * One row per person for lists and counts. The kept row is this device's
 * own row when it belongs to the person, else the first row in list order;
 * it carries the highest role among the person's devices.
 */
export function onePerPerson(
  members: ServerMember[],
  currentUserId: string | null
): ServerMember[] {
  const kept = new Map<string, number>()
  const out: ServerMember[] = []
  for (const m of members) {
    if (!m.personKey) {
      out.push(m)
      continue
    }
    const at = kept.get(m.personKey)
    if (at === undefined) {
      kept.set(m.personKey, out.length)
      out.push(m)
      continue
    }
    const prev = out[at]
    const role = ROLE_RANK[m.role] > ROLE_RANK[prev.role] ? m.role : prev.role
    const base = m.id === currentUserId ? m : prev
    out[at] = { ...base, role }
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
