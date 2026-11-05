import { describe, expect, it, vi } from "vitest"

vi.mock("novel", () => ({
  createSuggestionItems: (items: unknown[]) => items,
}))

import { createHushSlashItems } from "./custom-slash-commands"

describe("createHushSlashItems", () => {
  // Rituals fork: the GIF entry is hidden (no Giphy key on the space
  // host, and GIF media would load from Giphy's CDN).
  it("hides the GIF entry and keeps Poll as a shipping-soon action", () => {
    const items = createHushSlashItems({})

    expect(items.find((item) => item.title === "GIF")).toBeUndefined()
    expect(items.find((item) => item.title === "Poll")).toMatchObject({
      group: "actions",
      badge: "Shipping soon",
      disabled: true,
    })
  })
})
