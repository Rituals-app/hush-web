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
// incompatibility. onNeedRefresh never raises the blocking Update Required
// dialog and never reloads a running page; the next page load applies the build
// (src/lib/quietUpdate.ts, tested in quietUpdate.test.ts).
describe("a waiting Service Worker (onNeedRefresh)", () => {
  let dialogEvents: Event[];
  let diagnostics: { event?: string; details?: { outcome?: string } }[];
  const onDialogEvent = (event: Event) => dialogEvents.push(event);
  const onDiagnostic = (event: Event) => diagnostics.push((event as CustomEvent).detail);

  beforeEach(() => {
    dialogEvents = [];
    diagnostics = [];
    installServiceWorkerContainer();
    pwaRegisterMock.registerSW.mockImplementation(() => pwaRegisterMock.updateSW);
    window.addEventListener("hush:update-required", onDialogEvent);
    window.addEventListener("hush:diagnostic", onDiagnostic);
  });

  afterEach(() => {
    window.removeEventListener("hush:update-required", onDialogEvent);
    window.removeEventListener("hush:diagnostic", onDiagnostic);
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    pwaRegisterMock.registerSW.mockReset();
    pwaRegisterMock.updateSW.mockClear();
    updateRequiredMock.applyUpdate.mockClear();
  });

  function fireNeedRefresh() {
    const options = pwaRegisterMock.registerSW.mock.calls[0]?.[0] as RegisterOptions | undefined;
    expect(options?.onNeedRefresh).toBeTypeOf("function");
    options!.onNeedRefresh!();
  }

  it("keeps the running page as it is: no dialog, no update applied, no reload", async () => {
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    fireNeedRefresh();
    fireNeedRefresh(); // workbox-window can report the same waiting worker twice
    await Promise.resolve();

    expect(dialogEvents).toHaveLength(0);
    expect(updateRequiredMock.applyUpdate).not.toHaveBeenCalled();
    expect(pwaRegisterMock.updateSW).not.toHaveBeenCalled();
  });

  it("keeps the activator, so a dialog raised for a real incompatibility loads the new build", async () => {
    const { pwa, store } = await importFreshModules();
    pwa.registerPWA();

    fireNeedRefresh();
    await store.getWaitingUpdateSW()!();

    expect(pwaRegisterMock.updateSW).toHaveBeenCalledOnce();
    expect(pwaRegisterMock.updateSW).toHaveBeenCalledWith(true);
  });

  it("records that the build was kept for the next page load", async () => {
    const { pwa } = await importFreshModules();
    pwa.registerPWA();

    fireNeedRefresh();

    expect(diagnostics.filter((detail) => detail?.event === "sw-need-refresh")).toEqual([
      expect.objectContaining({ details: { outcome: "kept-for-next-load" } }),
    ]);
  });
});
