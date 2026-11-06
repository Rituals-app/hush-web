import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./chunkErrors";

// Rituals fork (2026-11-06): src/lib/chunkErrors.ts.
describe("isChunkLoadError", () => {
  it.each([
    ["Chrome", "Failed to fetch dynamically imported module: https://space.example.test/assets/appMain-old.js"],
    ["Firefox", "error loading dynamically imported module: https://space.example.test/assets/appMain-old.js"],
    ["Safari", "Importing a module script failed."],
    ["Vite (a stylesheet)", "Unable to preload CSS for /assets/Settings-old.css"],
  ])("recognises a failed load as %s words it", (_browser, message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
    expect(isChunkLoadError(new Error(message))).toBe(true);
    expect(isChunkLoadError(message)).toBe(true);
  });

  it("ignores letter case", () => {
    expect(isChunkLoadError(new TypeError("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE"))).toBe(true);
  });

  it.each([
    ["an ordinary error", new Error("boom")],
    ["a network error", new TypeError("Failed to fetch")],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { message: "Failed to fetch dynamically imported module" }],
    ["a number", 42],
  ])("is false for %s", (_label, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });

  it("is false for an error a module threw while it ran, whoever reported it", () => {
    // Vite's vite:preloadError carries these too; only the message counts.
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isChunkLoadError(new ReferenceError("CallPanel is not defined"))).toBe(false);
  });
});
