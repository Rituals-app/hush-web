import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rituals fork (2026-11-06): src/lib/chunkRecovery.ts. The Service Worker
// checks themselves are tested in quietUpdate.test.ts.
const quiet = vi.hoisted(() => ({
  controllerChangedSinceBoot: vi.fn<() => boolean>(() => false),
  findNewerBuild: vi.fn<() => Promise<boolean>>(async () => true),
  skipWaitingNow: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock("./quietUpdate", () => quiet);

type Listener = Parameters<typeof window.addEventListener>[1];

let added: [string, Listener][] = [];
let dialogEvents: CustomEvent[] = [];
const onDialogEvent = (event: Event) => dialogEvents.push(event as CustomEvent);

async function importFresh() {
  vi.resetModules();
  const recovery = await import("./chunkRecovery");
  const store = await import("./updateRequired");
  return { ...recovery, ...store };
}

/** Lets the shared check settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function firePreloadError(payload: unknown): Event {
  const event = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
  event.payload = payload;
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  added = [];
  dialogEvents = [];
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    added.push([type, listener]);
    original(type, listener, options);
  });
  window.addEventListener("hush:update-required", onDialogEvent);
  quiet.controllerChangedSinceBoot.mockReset().mockReturnValue(false);
  quiet.findNewerBuild.mockReset().mockResolvedValue(true);
  quiet.skipWaitingNow.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  for (const [type, listener] of added) window.removeEventListener(type, listener);
  vi.restoreAllMocks();
});

describe("installChunkRecovery", () => {
  it("offers a newer build when Vite reports a file that did not load, without stopping the error", async () => {
    const { installChunkRecovery } = await importFresh();
    installChunkRecovery();

    const event = firePreloadError(new TypeError("Failed to fetch dynamically imported module: https://space.example.test/assets/Call-old.js"));
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(quiet.findNewerBuild).toHaveBeenCalledOnce();
    expect(dialogEvents.map((e) => e.detail.reason)).toEqual(["chunk-load-failed"]);
  });

  it("offers nothing for an error a chunk threw while it ran", async () => {
    // Vite reports that too; a newer build is no fix for a code error.
    const { installChunkRecovery } = await importFresh();
    installChunkRecovery();

    firePreloadError(new Error("boom"));
    firePreloadError(undefined);
    await settle();

    expect(quiet.findNewerBuild).not.toHaveBeenCalled();
    expect(dialogEvents).toHaveLength(0);
  });

  it("listens once however often it is called", async () => {
    const { installChunkRecovery } = await importFresh();
    installChunkRecovery();
    installChunkRecovery();

    expect(added.filter(([type]) => type === "vite:preloadError")).toHaveLength(1);
  });
});

describe("offerNewerBuild", () => {
  it("shares one check between failures reported together", async () => {
    let finish!: (found: boolean) => void;
    quiet.findNewerBuild.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { offerNewerBuild } = await importFresh();

    const first = offerNewerBuild();
    const second = offerNewerBuild();
    finish(true);

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(quiet.findNewerBuild).toHaveBeenCalledOnce();
    expect(dialogEvents).toHaveLength(1);
  });

  it("raises nothing when there is no newer build, and can check again later", async () => {
    quiet.findNewerBuild.mockResolvedValueOnce(false);
    const { offerNewerBuild } = await importFresh();

    expect(await offerNewerBuild()).toBe(false);
    expect(dialogEvents).toHaveLength(0);

    expect(await offerNewerBuild()).toBe(true);
    expect(quiet.findNewerBuild).toHaveBeenCalledTimes(2);
    expect(dialogEvents).toHaveLength(1);
  });

  it("lets the dialog's Update activate the newer build", async () => {
    const { offerNewerBuild, getWaitingUpdateSW } = await importFresh();

    expect(await offerNewerBuild()).toBe(true);
    const activate = getWaitingUpdateSW();
    expect(activate).toBeTypeOf("function");

    expect(await activate!()).toBe(true);
    expect(quiet.skipWaitingNow).toHaveBeenCalledOnce();
  });

  it("says nothing was activated when nothing is waiting, so Update reloads at once", async () => {
    const { offerNewerBuild, getWaitingUpdateSW } = await importFresh();
    await offerNewerBuild();
    const activate = getWaitingUpdateSW()!;

    // Another page already activated it: nothing left waiting.
    quiet.skipWaitingNow.mockResolvedValueOnce(false);
    expect(await activate()).toBe(false);

    // The newer build already controls this page.
    quiet.controllerChangedSinceBoot.mockReturnValue(true);
    expect(await activate()).toBe(false);
    expect(quiet.skipWaitingNow).toHaveBeenCalledOnce();
  });

  it("checks once, then offers again on every later failure", async () => {
    // The person may choose Later; a later failure must reach the dialog.
    const { offerNewerBuild } = await importFresh();

    expect(await offerNewerBuild()).toBe(true);
    expect(await offerNewerBuild()).toBe(true);
    expect(await offerNewerBuild()).toBe(true);

    expect(quiet.findNewerBuild).toHaveBeenCalledOnce();
    expect(dialogEvents.map((e) => e.detail.reason)).toEqual(["chunk-load-failed", "chunk-load-failed", "chunk-load-failed"]);
  });

  it("keeps the activator the PWA layer already stored", async () => {
    const { offerNewerBuild, getWaitingUpdateSW, setWaitingUpdateSW } = await importFresh();
    const pwaActivator = vi.fn(async () => {});
    setWaitingUpdateSW(pwaActivator);

    await offerNewerBuild();

    expect(getWaitingUpdateSW()).toBe(pwaActivator);
    setWaitingUpdateSW(null);
  });
});
