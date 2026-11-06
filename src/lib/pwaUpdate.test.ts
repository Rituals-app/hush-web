import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RegisterOptions = { onNeedRefresh?: () => void };

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

const pwaRegisterMock = vi.hoisted(() => ({
  updateSW: vi.fn<UpdateSW>(async () => {}),
  registerSW: vi.fn<(options?: RegisterOptions) => UpdateSW>(() => async () => {}),
}));

const updateRequiredMock = vi.hoisted(() => ({
  applyUpdate: vi.fn(async () => {}),
}));

vi.mock("virtual:pwa-register", () => ({
  registerSW: pwaRegisterMock.registerSW,
}));

vi.mock("./updateRequired", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./updateRequired")>();
  return { ...actual, applyUpdate: updateRequiredMock.applyUpdate };
});

function installServiceWorkerContainer() {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {},
  });
}

async function importFreshPwaUpdate() {
  vi.resetModules();
  return import("./pwaUpdate");
}

async function importFreshModules() {
  const pwa = await importFreshPwaUpdate();
  const store = await import("./updateRequired");
  return { pwa, store };
}

describe("registerPWA", () => {
  afterEach(() => {
    delete (window as unknown as { hushDesktop?: unknown }).hushDesktop;
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    pwaRegisterMock.registerSW.mockClear();
  });

  it("registers the Service Worker in a normal browser renderer", async () => {
    installServiceWorkerContainer();
    const { registerPWA } = await importFreshPwaUpdate();

    registerPWA();

    expect(pwaRegisterMock.registerSW).toHaveBeenCalledOnce();
  });

  it("does not register the Service Worker in the Electron desktop renderer", async () => {
    installServiceWorkerContainer();
    (window as unknown as { hushDesktop?: { isDesktop: boolean } }).hushDesktop = {
      isDesktop: true,
    };
    const { registerPWA } = await importFreshPwaUpdate();

    registerPWA();

    expect(pwaRegisterMock.registerSW).not.toHaveBeenCalled();
  });
});

// Rituals fork (2026-11-06): a waiting Service Worker is a newer build, not an
// incompatibility, so it never raises the blocking Update Required dialog.
describe("a waiting Service Worker (onNeedRefresh)", () => {
  let dialogEvents: Event[];
  const onDialogEvent = (event: Event) => dialogEvents.push(event);

  beforeEach(() => {
    dialogEvents = [];
    installServiceWorkerContainer();
    window.sessionStorage.clear();
    pwaRegisterMock.registerSW.mockImplementation(() => pwaRegisterMock.updateSW);
    window.addEventListener("hush:update-required", onDialogEvent);
  });

  afterEach(() => {
    window.removeEventListener("hush:update-required", onDialogEvent);
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    pwaRegisterMock.registerSW.mockReset();
    pwaRegisterMock.updateSW.mockClear();
    updateRequiredMock.applyUpdate.mockClear();
  });

  function fireNeedRefresh() {
    const options = pwaRegisterMock.registerSW.mock.calls[0]?.[0] as RegisterOptions | undefined;
    expect(options?.onNeedRefresh).toBeTypeOf("function");
    options!.onNeedRefresh!();
  }

  it("applies the update at once when nobody has touched the page", async () => {
    const { pwa, store } = await importFreshModules();
    pwa.registerPWA();

    fireNeedRefresh();

    expect(updateRequiredMock.applyUpdate).toHaveBeenCalledOnce();
    expect(dialogEvents).toHaveLength(0);
    expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).not.toBeNull();
    // The stored activator is the plugin's updater (reload on take-over).
    await store.getWaitingUpdateSW()!();
    expect(pwaRegisterMock.updateSW).toHaveBeenCalledWith(true);
  });

  it.each(["pointerdown", "keydown", "touchstart"])(
    "leaves the person alone after a %s, and keeps the activator for a real dialog",
    async (type) => {
      const { pwa, store } = await importFreshModules();
      pwa.registerPWA();
      window.dispatchEvent(new Event(type));

      fireNeedRefresh();

      expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
      expect(dialogEvents).toHaveLength(0);
      expect(store.getWaitingUpdateSW()).toBeTypeOf("function");
      expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).toBeNull();
    },
  );

  it("applies at most one quiet update per tab within the retry window", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { pwa } = await importFreshModules();
    window.sessionStorage.setItem(
      pwa.QUIET_UPDATE_STORAGE_KEY,
      String(now - pwa.QUIET_UPDATE_RETRY_MS + 1),
    );
    pwa.registerPWA();

    fireNeedRefresh();

    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
    expect(dialogEvents).toHaveLength(0);
  });

  it("applies again once the retry window has passed", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { pwa } = await importFreshModules();
    window.sessionStorage.setItem(
      pwa.QUIET_UPDATE_STORAGE_KEY,
      String(now - pwa.QUIET_UPDATE_RETRY_MS),
    );
    pwa.registerPWA();

    fireNeedRefresh();

    expect(updateRequiredMock.applyUpdate).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).toBe(String(now));
  });

  it("never applies quietly when the loop guard cannot be stored", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    fireNeedRefresh();

    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
    expect(dialogEvents).toHaveLength(0);
  });
});
