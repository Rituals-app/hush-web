import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rituals fork (2026-11-06): src/lib/chunkRecovery.ts. The Service Worker
// checks themselves are tested in quietUpdate.test.ts.
const quiet = vi.hoisted(() => ({
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
  const errors = await import("./chunkErrors");
  const store = await import("./updateRequired");
  return { ...recovery, ...errors, ...store };
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
  quiet.findNewerBuild.mockReset().mockResolvedValue(true);
  quiet.skipWaitingNow.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  for (const [type, listener] of added) window.removeEventListener(type, listener);
  vi.restoreAllMocks();
});

describe("installChunkRecovery", () => {
  it("marks the error Vite reports and offers a newer build, without stopping the error", async () => {
    const { installChunkRecovery, isChunkLoadError } = await importFresh();
    installChunkRecovery();
    const failure = new Error("boom");

    const event = firePreloadError(failure);
    await settle();

    expect(isChunkLoadError(failure)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(quiet.findNewerBuild).toHaveBeenCalledOnce();
    expect(dialogEvents.map((e) => e.detail.reason)).toEqual(["chunk-load-failed"]);
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

  it("lets the dialog's Update activate the newer build, and offers it only once", async () => {
    const { offerNewerBuild, getWaitingUpdateSW } = await importFresh();

    expect(await offerNewerBuild()).toBe(true);
    const activate = getWaitingUpdateSW();
    expect(activate).toBeTypeOf("function");
    await activate!();
    expect(quiet.skipWaitingNow).toHaveBeenCalledOnce();

    expect(await offerNewerBuild()).toBe(true);
    expect(quiet.findNewerBuild).toHaveBeenCalledOnce();
    expect(dialogEvents).toHaveLength(1);
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
