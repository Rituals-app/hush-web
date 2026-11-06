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

  it("keeps one row per person with the highest role and this device's row", () => {
    const list = unifyPeople([
      row({ id: "a1", personKey: "k", role: "owner", displayName: "Ann", name: "Ann", joinedAt: "2026-01-01" }),
      row({ id: "a2", personKey: "k", role: "member", name: "ann-2", joinedAt: "2026-02-01" }),
      row({ id: "c", role: "admin" }),
    ])
    const people = onePerPerson(list, "a2")
    expect(people).toHaveLength(2)
    expect(people[0]).toMatchObject({ id: "a2", name: "Ann", role: "owner", username: null })
    expect(people[1].id).toBe("c")
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
