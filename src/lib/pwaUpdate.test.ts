import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RegisterOptions = { onNeedRefresh?: () => void };

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

const pwaRegisterMock = vi.hoisted(() => ({
  updateSW: vi.fn<UpdateSW>(async () => {}),
  registerSW: vi.fn<(options?: RegisterOptions) => UpdateSW>(() => async () => {}),
}));

const updateRequiredMock = vi.hoisted(() => ({
  applyUpdate: vi.fn<(options?: { location?: Pick<Location, "reload"> }) => Promise<void>>(async () => {}),
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

  /** A fake Web Locks API. `otherPages` shared presence locks are already held. */
  function installLocks({ otherPages = 0 } = {}) {
    const held: { name: string; mode: string }[] = [];
    const locks = {
      request: vi.fn((name: string, _options: unknown, callback: () => Promise<never>) => {
        held.push({ name, mode: "shared" });
        return callback();
      }),
      query: vi.fn(async () => ({
        held: [
          ...held,
          ...Array.from({ length: otherPages }, () => ({ name: "hush_sw_page_presence", mode: "shared" })),
        ],
        pending: [],
      })),
    };
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
    return locks;
  }

  /** Resolves with the outcome the next quiet-update decision records. */
  function nextOutcome(): Promise<string> {
    return new Promise((resolve) => {
      const onDiagnostic = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.event !== "sw-need-refresh") return;
        window.removeEventListener("hush:diagnostic", onDiagnostic);
        resolve(detail.details.outcome);
      };
      window.addEventListener("hush:diagnostic", onDiagnostic);
    });
  }

  beforeEach(() => {
    dialogEvents = [];
    installServiceWorkerContainer();
    installLocks();
    window.sessionStorage.clear();
    pwaRegisterMock.registerSW.mockImplementation(() => pwaRegisterMock.updateSW);
    window.addEventListener("hush:update-required", onDialogEvent);
  });

  afterEach(() => {
    window.removeEventListener("hush:update-required", onDialogEvent);
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    delete (navigator as unknown as { locks?: unknown }).locks;
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    pwaRegisterMock.registerSW.mockReset();
    pwaRegisterMock.updateSW.mockClear();
    updateRequiredMock.applyUpdate.mockClear();
  });

  function fireNeedRefresh(): Promise<string> {
    const outcome = nextOutcome();
    const options = pwaRegisterMock.registerSW.mock.calls[0]?.[0] as RegisterOptions | undefined;
    expect(options?.onNeedRefresh).toBeTypeOf("function");
    options!.onNeedRefresh!();
    return outcome;
  }

  function setHidden() {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  }

  it("applies the update at once on a fresh, untouched, only Space page", async () => {
    const { pwa, store } = await importFreshModules();
    pwa.registerPWA();

    expect(await fireNeedRefresh()).toBe("applied");

    expect(updateRequiredMock.applyUpdate).toHaveBeenCalledOnce();
    expect(dialogEvents).toHaveLength(0);
    expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).not.toBeNull();
    // The stored activator is the plugin's updater (reload on take-over).
    await store.getWaitingUpdateSW()!();
    expect(pwaRegisterMock.updateSW).toHaveBeenCalledWith(true);
  });

  it.each(["pointerdown", "keydown", "touchstart", "wheel"])(
    "leaves the person alone after a %s, and keeps the activator for a real dialog",
    async (type) => {
      const { pwa, store } = await importFreshModules();
      pwa.registerPWA();
      window.dispatchEvent(new Event(type));

      expect(await fireNeedRefresh()).toBe("deferred-interacted");

      expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
      expect(dialogEvents).toHaveLength(0);
      expect(store.getWaitingUpdateSW()).toBeTypeOf("function");
      expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).toBeNull();
    },
  );

  it("never applies quietly while another Space page is open (it would reload that page too)", async () => {
    installLocks({ otherPages: 1 });
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    expect(await fireNeedRefresh()).toBe("deferred-other-pages");

    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
    expect(dialogEvents).toHaveLength(0);
    expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).toBeNull();
  });

  it("never applies quietly without the Web Locks API (other pages cannot be seen)", async () => {
    delete (navigator as unknown as { locks?: unknown }).locks;
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    expect(await fireNeedRefresh()).toBe("deferred-other-pages");

    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
  });

  it("leaves a visible page alone when the build arrives after the first moments", async () => {
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { pwa } = await importFreshModules();
    pwa.registerPWA();
    clock += pwa.QUIET_UPDATE_WINDOW_MS + 1;

    expect(await fireNeedRefresh()).toBe("deferred-late");

    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
    expect(dialogEvents).toHaveLength(0);
  });

  it("applies a late build while the page is hidden and still untouched", async () => {
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { pwa } = await importFreshModules();
    pwa.registerPWA();
    clock += pwa.QUIET_UPDATE_WINDOW_MS + 1;
    setHidden();

    expect(await fireNeedRefresh()).toBe("applied");

    expect(updateRequiredMock.applyUpdate).toHaveBeenCalledOnce();
  });

  it("skips the fallback reload when the person starts using the page meanwhile", async () => {
    const skipped: string[] = [];
    const onDiagnostic = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.event === "sw-quiet-reload-skipped") skipped.push(detail.details.reason);
    };
    window.addEventListener("hush:diagnostic", onDiagnostic);
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    expect(await fireNeedRefresh()).toBe("applied");
    const options = updateRequiredMock.applyUpdate.mock.calls[0]?.[0];
    expect(options?.location?.reload).toBeTypeOf("function");
    window.dispatchEvent(new Event("keydown"));
    options!.location!.reload();

    window.removeEventListener("hush:diagnostic", onDiagnostic);
    expect(skipped).toEqual(["interacted"]);
  });

  it("applies at most one quiet update per tab within the retry window", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { pwa } = await importFreshModules();
    window.sessionStorage.setItem(
      pwa.QUIET_UPDATE_STORAGE_KEY,
      String(now - pwa.QUIET_UPDATE_RETRY_MS + 1),
    );
    pwa.registerPWA();

    expect(await fireNeedRefresh()).toBe("deferred-recent");

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

    expect(await fireNeedRefresh()).toBe("applied");

    expect(updateRequiredMock.applyUpdate).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(pwa.QUIET_UPDATE_STORAGE_KEY)).toBe(String(now));
  });

  it("never applies quietly when the loop guard cannot be stored", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    expect(await fireNeedRefresh()).toBe("deferred-no-storage");

    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
    expect(dialogEvents).toHaveLength(0);
  });
});
