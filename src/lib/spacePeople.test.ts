import { describe, expect, it } from "vitest"

import type { ServerMember, VoiceParticipantInfo } from "@/adapters/types"
import { onePerPerson, onePersonPerVoiceSlot, unifyPeople } from "./spacePeople"

function row(over: Partial<ServerMember> & { id: string }): ServerMember {
  return {
    name: over.id,
    initials: over.id.slice(0, 2).toUpperCase(),
    presence: "offline",
    role: "member",
    username: over.id,
    displayName: null,
    createdAt: null,
    joinedAt: null,
    homeInstance: null,
    ...over,
  }
}

describe("spacePeople", () => {
  it("returns the same list when no row has a person key", () => {
    const list = [row({ id: "a" }), row({ id: "b" })]
    expect(unifyPeople(list)).toBe(list)
    expect(onePerPerson(list, "a")).toEqual(list)
  })

  it("names a person from the latest-joined device and keeps list position", () => {
    const list = unifyPeople([
      row({ id: "a1", personKey: "k", displayName: "Ann", name: "Ann", joinedAt: "2026-01-01" }),
      row({ id: "c" }),
      row({ id: "a2", personKey: "k", displayName: "Ann R", name: "Ann R", joinedAt: "2026-02-01" }),
    ])
    expect(list.map((m) => [m.id, m.name, m.username])).toEqual([
      ["a1", "Ann R", null],
      ["c", "c", "c"],
      ["a2", "Ann R", null],
    ])
    expect(onePerPerson(list, "c").map((m) => m.id)).toEqual(["a2", "c"])
  })

  it("targets another person's online device, else their latest device, with the highest role", () => {
    const seats = [
      row({ id: "b1", personKey: "b", role: "admin", joinedAt: "2026-01-01", presence: "online" }),
      row({ id: "b2", personKey: "b", role: "member", joinedAt: "2026-02-01" }),
      row({ id: "b3", personKey: "b", role: "member", joinedAt: "2026-03-01" }),
    ]
    // b1 is online: it is the target even though it is the oldest.
    expect(onePerPerson(seats, "me")[0]).toMatchObject({ id: "b1", role: "admin" })
    // Nobody online: the latest-joined device, still the highest role.
    const offline = seats.map((m) => ({ ...m, presence: "offline" as const }))
    expect(onePerPerson(offline, "me")).toEqual([
      expect.objectContaining({ id: "b3", role: "admin" }),
    ])
  })

  it("keeps this device's own row and role for my own person", () => {
    const seats = [
      row({ id: "a1", personKey: "k", role: "owner", joinedAt: "2026-01-01", presence: "online" }),
      row({ id: "a2", personKey: "k", role: "member", joinedAt: "2026-02-01" }),
      row({ id: "c", role: "admin" }),
    ]
    const people = onePerPerson(unifyPeople(seats), "a2")
    expect(people).toHaveLength(2)
    expect(people[0]).toMatchObject({ id: "a2", role: "member", username: null })
    expect(people[1].id).toBe("c")
  })

  it("gives my own merged row the latest device's name and this device's role", () => {
    const seats = [
      // This device: the oldest seat, an owner, offline.
      row({ id: "me1", personKey: "me", role: "owner", displayName: "Sam", name: "Sam", joinedAt: "2026-01-01" }),
      // Another of my devices, joined later, renamed, online, a member.
      row({ id: "me2", personKey: "me", role: "member", displayName: "Sam K", name: "Sam K", joinedAt: "2026-03-01", presence: "online" }),
      // My newest device has no display name yet: the latest named one wins.
      row({ id: "me3", personKey: "me", role: "member", joinedAt: "2026-04-01" }),
    ]
    const people = onePerPerson(unifyPeople(seats), "me1")
    expect(people).toEqual([
      expect.objectContaining({ id: "me1", name: "Sam K", displayName: "Sam K", role: "owner", presence: "online", username: null }),
    ])
    // From another device of mine (a member), the same name and that device's role.
    expect(onePerPerson(unifyPeople(seats), "me3")).toEqual([
      expect.objectContaining({ id: "me3", name: "Sam K", role: "member" }),
    ])
  })

  it("shows one voice entry per person and keeps this device's own entry", () => {
    const members = unifyPeople([
      row({ id: "a1", personKey: "k", displayName: "Ann", name: "Ann" }),
      row({ id: "a2", personKey: "k", name: "ann-2" }),
      row({ id: "b" }),
    ])
    const voice: VoiceParticipantInfo[] = [
      { id: "a1", name: "ann-1", initials: "A" },
      { id: "b", name: "b", initials: "B" },
      { id: "a2", name: "You", initials: "A" },
    ]
    const out = onePersonPerVoiceSlot(voice, members, "a2")
    expect(out.map((p) => [p.id, p.name])).toEqual([
      ["b", "b"],
      ["a2", "You"],
    ])
    expect(onePersonPerVoiceSlot(voice, [row({ id: "a1" })], "a2")).toBe(voice)
  })
})
