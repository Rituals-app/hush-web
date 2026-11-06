import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rituals fork (2026-11-06): the boot-time update step (src/lib/quietUpdate.ts).
// navigator.serviceWorker and navigator.locks are fakes: jsdom has neither.

type Grant = "now" | "late" | "never" | "reject";
type RegistrationMode = "present" | "none" | "hang" | "reject";
/** What registration.update() finds. */
type UpdateCheck = "nothing" | "finds" | "reject";

interface FakeEnv {
  controlled?: boolean;
  registration?: RegistrationMode;
  waiting?: boolean;
  /** A newer build is still installing. */
  installing?: boolean;
  update?: UpdateCheck;
  /** The new worker takes control right after SKIP_WAITING. */
  takesControl?: boolean;
  postThrows?: boolean;
  waitingGetterThrows?: boolean;
  locks?: boolean;
  grant?: Grant;
  queryHangs?: boolean;
  otherHeld?: number;
  otherPending?: number;
}

const NOW = 1_800_000_000_000;
const PRESENCE = "hush_sw_page_presence";

function installEnvironment(env: FakeEnv = {}) {
  const listeners = new Set<() => void>();
  const fireControllerChange = () => [...listeners].forEach((listener) => listener());
  const onPost = () => {
    if (env.postThrows) throw new Error("worker gone");
    if (env.takesControl !== false) void Promise.resolve().then(fireControllerChange);
  };

  function makeWorker(initial: string) {
    const stateListeners = new Set<() => void>();
    const worker = {
      state: initial,
      postMessage: vi.fn(onPost),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === "statechange") stateListeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === "statechange") stateListeners.delete(listener);
      }),
      setState(next: string) {
        worker.state = next;
        [...stateListeners].forEach((listener) => listener());
      },
    };
    return worker;
  }
  type Worker = ReturnType<typeof makeWorker>;

  const waiting = env.waiting === false ? null : makeWorker("installed");
  const updateFound = new Set<() => void>();
  const registration = {
    waiting: waiting as Worker | null,
    installing: (env.installing ? makeWorker("installing") : null) as Worker | null,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "updatefound") updateFound.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "updatefound") updateFound.delete(listener);
    }),
    update: vi.fn(() => {
      switch (env.update ?? "nothing") {
        case "finds":
          startInstall();
          return Promise.resolve(registration);
        case "reject":
          return Promise.reject(new Error("offline"));
        default:
          return Promise.resolve(registration);
      }
    }),
  };
  if (env.waitingGetterThrows) {
    Object.defineProperty(registration, "waiting", { get: () => { throw new Error("broken"); } });
  }

  /** The browser found a newer sw.js and started installing it. */
  function startInstall() {
    registration.installing = makeWorker("installing");
    [...updateFound].forEach((listener) => listener());
  }
  /** Install finished: the worker is waiting before its state says so (as in the spec). */
  function finishInstall() {
    const worker = registration.installing!;
    registration.installing = null;
    registration.waiting = worker;
    worker.setState("installed");
    return worker;
  }
  function failInstall() {
    const worker = registration.installing!;
    registration.installing = null;
    worker.setState("redundant");
  }

  const container = {
    controller: (env.controlled === false ? null : {}) as object | null,
    getRegistration: vi.fn(() => {
      switch (env.registration ?? "present") {
        case "none": return Promise.resolve(undefined);
        case "hang": return new Promise<never>(() => {});
        case "reject": return Promise.reject(new Error("no registration"));
        default: return Promise.resolve(registration);
      }
    }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "controllerchange") listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "controllerchange") listeners.delete(listener);
    }),
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });

  const held: { name: string; mode: string }[] = [];
  const locks = {
    request: vi.fn((name: string, options: { mode?: string }, callback: () => Promise<never>) => {
      const grant = () => {
        held.push({ name, mode: options.mode ?? "exclusive" });
        return callback();
      };
      switch (env.grant ?? "now") {
        case "late": return new Promise((resolve) => setTimeout(() => resolve(grant()), 2_000));
        case "never": return new Promise<never>(() => {});
        case "reject": return Promise.reject(new Error("lock refused"));
        default: return Promise.resolve().then(grant);
      }
    }),
    query: vi.fn(() => env.queryHangs
      ? new Promise<never>(() => {})
      : Promise.resolve({
          held: [
            ...held,
            ...Array.from({ length: env.otherHeld ?? 0 }, () => ({ name: PRESENCE, mode: "shared" })),
          ],
          pending: Array.from({ length: env.otherPending ?? 0 }, () => ({ name: PRESENCE, mode: "shared" })),
        })),
  };
  if (env.locks !== false) {
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  }

  return { container, registration, waiting, locks, startInstall, finishInstall, failInstall };
}

let diagnostics: { event?: string; details?: { outcome?: string } }[];
const onDiagnostic = (event: Event) => diagnostics.push((event as CustomEvent).detail);

let loaded: typeof import("./quietUpdate") | null = null;

async function importFresh() {
  vi.resetModules();
  loaded = await import("./quietUpdate");
  return loaded;
}

/** Runs the boot step with the clock advanced far enough for every timeout. */
async function runToEnd() {
  const { applyWaitingBuildAtStart } = await importFresh();
  const reload = vi.fn();
  const promise = applyWaitingBuildAtStart({ reload });
  await vi.advanceTimersByTimeAsync(10_000);
  return { outcome: await promise, reload };
}

/** Outcomes the diagnostic log has received so far. */
function recordedOutcomes() {
  return diagnostics.filter((detail) => detail?.event === "sw-boot-update").map((detail) => detail.details?.outcome);
}

/** Outcomes once the diagnostic log listens (src/appMain.jsx flushes them). */
function bootOutcomes() {
  loaded?.flushBootUpdateDiagnostics();
  return recordedOutcomes();
}

/** Settles `promise` into `box.value` without awaiting it, so a test can check it has not resolved yet. */
function track<T>(promise: Promise<T>) {
  const box: { value?: T } = {};
  void promise.then((value) => { box.value = value; });
  return box;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.sessionStorage.clear();
  diagnostics = [];
  window.addEventListener("hush:diagnostic", onDiagnostic);
});

afterEach(() => {
  window.removeEventListener("hush:diagnostic", onDiagnostic);
  loaded = null;
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  delete (navigator as unknown as { locks?: unknown }).locks;
  delete (window as unknown as { hushDesktop?: unknown }).hushDesktop;
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("applyWaitingBuildAtStart", () => {
  it("activates the waiting build and reloads once the new worker has taken control", async () => {
    const { waiting, locks } = installEnvironment();
    const { applyWaitingBuildAtStart, QUIET_UPDATE_STORAGE_KEY } = await importFresh();
    const reload = vi.fn();

    // No timer is advanced: the reload must follow controllerchange, not the timeout.
    const outcome = await applyWaitingBuildAtStart({ reload });

    expect(outcome).toBe("applied");
    expect(waiting!.postMessage).toHaveBeenCalledOnce();
    expect(waiting!.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY)).toBe(String(NOW));
    expect(locks.request).toHaveBeenCalledOnce();
    expect(locks.request.mock.calls[0]?.[0]).toBe(PRESENCE);
    expect(locks.request.mock.calls[0]?.[1]).toEqual({ mode: "shared" });
    expect(bootOutcomes()).toEqual(["applied"]);
  });

  it("reloads after the activation timeout when the new worker never reports control", async () => {
    installEnvironment({ takesControl: false });
    const { applyWaitingBuildAtStart, QUIET_UPDATE_ACTIVATE_TIMEOUT_MS } = await importFresh();
    const reload = vi.fn();

    const promise = applyWaitingBuildAtStart({ reload });
    await vi.advanceTimersByTimeAsync(QUIET_UPDATE_ACTIVATE_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await promise).toBe("applied");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("holds the presence lock for the page's lifetime (the callback never settles)", async () => {
    const { locks } = installEnvironment({ waiting: false });
    await runToEnd();

    const callback = locks.request.mock.calls[0]?.[2] as () => Promise<never>;
    let settled = false;
    void callback().then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });

  it.each<RegistrationMode>(["none", "hang", "reject"])(
    "boots the current build when there is no registration (%s)",
    async (registration) => {
      installEnvironment({ registration });
      const { outcome, reload } = await runToEnd();

      expect(outcome).toBe("no-registration");
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it("boots the current build when no newer build is waiting, but still announces the page", async () => {
    const { locks } = installEnvironment({ waiting: false });
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("none-waiting");
    expect(reload).not.toHaveBeenCalled();
    expect(locks.request).toHaveBeenCalledOnce();
    expect(bootOutcomes()).toEqual(["none-waiting"]);
  });

  it("never activates for a page that no worker controls (it came from the network)", async () => {
    const { waiting } = installEnvironment({ controlled: false });
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("uncontrolled");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["another page holds the presence lock", { otherHeld: 1 }],
    ["another page is waiting for the presence lock", { otherPending: 1 }],
  ])("never activates while %s (activation would reload it too)", async (_label, env) => {
    const { waiting } = installEnvironment(env);
    const { applyWaitingBuildAtStart, QUIET_UPDATE_STORAGE_KEY } = await importFresh();
    const reload = vi.fn();
    const promise = applyWaitingBuildAtStart({ reload });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await promise).toBe("other-pages");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY)).toBeNull();
  });

  it("never activates without the Web Locks API (other pages cannot be seen)", async () => {
    const { waiting } = installEnvironment({ locks: false });
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("no-locks");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each<Grant>(["late", "never", "reject"])(
    "never activates when the presence lock is not granted in time (%s)",
    async (grant) => {
      const { waiting } = installEnvironment({ grant });
      const { outcome, reload } = await runToEnd();

      expect(outcome).toBe("lock-late");
      expect(waiting!.postMessage).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it("activates at most once per tab within the retry window", async () => {
    const { waiting } = installEnvironment();
    const { QUIET_UPDATE_STORAGE_KEY, QUIET_UPDATE_RETRY_MS } = await importFresh();
    window.sessionStorage.setItem(QUIET_UPDATE_STORAGE_KEY, String(NOW - QUIET_UPDATE_RETRY_MS + 1));

    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("recent");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["the retry window has passed", -2 * 60 * 1000],
    ["the stored time is in the future (clock moved back)", 60_000],
    ["the stored time is not a number", Number.NaN],
  ])("activates again when %s", async (_label, offset) => {
    installEnvironment();
    const { QUIET_UPDATE_STORAGE_KEY } = await importFresh();
    window.sessionStorage.setItem(
      QUIET_UPDATE_STORAGE_KEY,
      Number.isNaN(offset) ? "garbage" : String(NOW + offset),
    );

    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("applied");
    expect(reload).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY)).toBe(String(NOW));
  });

  it("never activates when the loop guard cannot be stored", async () => {
    const { waiting } = installEnvironment();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("no-storage");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing in the Electron desktop renderer (no lock, no registration lookup)", async () => {
    const { container, locks } = installEnvironment();
    (window as unknown as { hushDesktop?: { isDesktop: boolean } }).hushDesktop = { isDesktop: true };

    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("unsupported");
    expect(locks.request).not.toHaveBeenCalled();
    expect(container.getRegistration).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing without Service Worker support", async () => {
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("unsupported");
    expect(reload).not.toHaveBeenCalled();
  });

  it("boots the current build when the waiting worker cannot be told to activate", async () => {
    installEnvironment({ postThrows: true });
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("post-failed");
    expect(reload).not.toHaveBeenCalled();
    expect(bootOutcomes()).toEqual(["post-failed"]);
  });

  it("never rejects: an unexpected failure lets boot carry on", async () => {
    installEnvironment({ waitingGetterThrows: true });
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("error");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("applyWaitingBuildAtStart: the alone check", () => {
  it("never activates when the lock list does not answer in time", async () => {
    const { waiting } = installEnvironment({ queryHangs: true });
    const { outcome, reload } = await runToEnd();

    expect(outcome).toBe("other-pages");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("applyWaitingBuildAtStart({ awaitInstall }): a page whose build failed to load", () => {
  it("waits for a newer build that is still installing, then applies it", async () => {
    const { registration, finishInstall } = installEnvironment({ waiting: false, installing: true });
    const { applyWaitingBuildAtStart } = await importFresh();
    const reload = vi.fn();

    const result = track(applyWaitingBuildAtStart({ reload, awaitInstall: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.value).toBeUndefined();

    const worker = finishInstall();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe("applied");
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).toHaveBeenCalledOnce();
    // Something was already installing: no extra check was needed.
    expect(registration.update).not.toHaveBeenCalled();
  });

  it("asks the browser to check when nothing is installing yet, then applies what it finds", async () => {
    const { registration, finishInstall } = installEnvironment({ waiting: false, update: "finds" });
    const { applyWaitingBuildAtStart } = await importFresh();
    const reload = vi.fn();

    const result = track(applyWaitingBuildAtStart({ reload, awaitInstall: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(result.value).toBeUndefined();

    finishInstall();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe("applied");
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each<[string, FakeEnv, ((env: ReturnType<typeof installEnvironment>) => void) | null]>([
    ["the check finds nothing", { waiting: false, update: "nothing" }, null],
    ["the check fails (offline)", { waiting: false, update: "reject" }, null],
    ["the newer build fails to install", { waiting: false, installing: true }, (env) => env.failInstall()],
  ])("boots on at once when %s", async (_label, setup, act) => {
    const env = installEnvironment(setup);
    const { applyWaitingBuildAtStart } = await importFresh();
    const reload = vi.fn();

    const result = track(applyWaitingBuildAtStart({ reload, awaitInstall: true }));
    await vi.advanceTimersByTimeAsync(10);
    act?.(env);
    await vi.advanceTimersByTimeAsync(10);

    // Well before the install timeout.
    expect(result.value).toBe("none-waiting");
    expect(reload).not.toHaveBeenCalled();
  });

  it("gives up after the install timeout", async () => {
    installEnvironment({ waiting: false, installing: true });
    const { applyWaitingBuildAtStart, QUIET_UPDATE_INSTALL_TIMEOUT_MS } = await importFresh();
    const reload = vi.fn();

    const result = track(applyWaitingBuildAtStart({ reload, awaitInstall: true }));
    await vi.advanceTimersByTimeAsync(QUIET_UPDATE_INSTALL_TIMEOUT_MS - 1);
    expect(result.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result.value).toBe("none-waiting");
    expect(reload).not.toHaveBeenCalled();
  });

  it("still never activates while other pages are open", async () => {
    const { finishInstall } = installEnvironment({ waiting: false, installing: true, otherHeld: 1 });
    const { applyWaitingBuildAtStart } = await importFresh();
    const reload = vi.fn();

    const result = track(applyWaitingBuildAtStart({ reload, awaitInstall: true }));
    await vi.advanceTimersByTimeAsync(10);
    const worker = finishInstall();
    await vi.advanceTimersByTimeAsync(10);

    expect(result.value).toBe("other-pages");
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("never waits or checks for an install without awaitInstall", async () => {
    const { registration } = installEnvironment({ waiting: false, update: "finds" });
    const { outcome } = await runToEnd();

    expect(outcome).toBe("none-waiting");
    expect(registration.update).not.toHaveBeenCalled();
  });
});

describe("a newer build took over while this page booted (taken-over)", () => {
  it("reloads at once without activating anything", async () => {
    const { container, waiting, locks } = installEnvironment();
    const { applyWaitingBuildAtStart, controllerChangedSinceBoot, QUIET_UPDATE_STORAGE_KEY } = await importFresh();
    container.controller = {};
    const reload = vi.fn();

    expect(controllerChangedSinceBoot()).toBe(true);
    expect(await applyWaitingBuildAtStart({ reload })).toBe("taken-over");
    expect(reload).toHaveBeenCalledOnce();
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(QUIET_UPDATE_STORAGE_KEY)).toBe(String(NOW));
    // The page still announces itself.
    expect(locks.request).toHaveBeenCalledOnce();
  });

  it("notices a takeover that happens while the registration is looked up", async () => {
    const { container, registration, waiting } = installEnvironment();
    const { applyWaitingBuildAtStart } = await importFresh();
    container.getRegistration.mockImplementationOnce(async () => {
      container.controller = {};
      return registration;
    });
    const reload = vi.fn();

    expect(await applyWaitingBuildAtStart({ reload })).toBe("taken-over");
    expect(waiting!.postMessage).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload again within the retry window", async () => {
    const { container } = installEnvironment();
    const { applyWaitingBuildAtStart, QUIET_UPDATE_STORAGE_KEY } = await importFresh();
    window.sessionStorage.setItem(QUIET_UPDATE_STORAGE_KEY, String(NOW - 1_000));
    container.controller = {};
    const reload = vi.fn();

    expect(await applyWaitingBuildAtStart({ reload })).toBe("recent");
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["the page had no worker at boot (it came from the network)", { controlled: false }, {}],
    ["the page lost its worker", {}, null],
  ])("is not a takeover when %s", async (_label, setup, next) => {
    const { container } = installEnvironment(setup);
    const { controllerChangedSinceBoot } = await importFresh();
    container.controller = next;

    expect(controllerChangedSinceBoot()).toBe(false);
  });

  it("is never a takeover in the Electron desktop renderer", async () => {
    const { container } = installEnvironment();
    const { controllerChangedSinceBoot } = await importFresh();
    container.controller = {};
    (window as unknown as { hushDesktop?: { isDesktop: boolean } }).hushDesktop = { isDesktop: true };

    expect(controllerChangedSinceBoot()).toBe(false);
  });
});

describe("flushBootUpdateDiagnostics", () => {
  it("keeps boot outcomes until the diagnostic log listens, then records them in order and later ones at once", async () => {
    const { container } = installEnvironment({ waiting: false });
    const { applyWaitingBuildAtStart, flushBootUpdateDiagnostics } = await importFresh();
    const reload = vi.fn();

    await applyWaitingBuildAtStart({ reload });
    container.controller = {};
    await applyWaitingBuildAtStart({ reload });
    expect(recordedOutcomes()).toEqual([]);

    flushBootUpdateDiagnostics();
    expect(recordedOutcomes()).toEqual(["none-waiting", "taken-over"]);

    await applyWaitingBuildAtStart({ reload });
    flushBootUpdateDiagnostics();
    expect(recordedOutcomes()).toEqual(["none-waiting", "taken-over", "recent"]);
  });
});

describe("findNewerBuild", () => {
  it("finds a newer build that is waiting", async () => {
    installEnvironment();
    const { findNewerBuild } = await importFresh();

    expect(await findNewerBuild()).toBe(true);
  });

  it("finds a newer build once it finishes installing", async () => {
    const { finishInstall } = installEnvironment({ waiting: false, installing: true });
    const { findNewerBuild } = await importFresh();

    const result = track(findNewerBuild());
    await vi.advanceTimersByTimeAsync(10);
    expect(result.value).toBeUndefined();
    finishInstall();
    await vi.advanceTimersByTimeAsync(0);

    expect(result.value).toBe(true);
  });

  it("finds the newer build that already took over, without a lookup", async () => {
    const { container } = installEnvironment({ waiting: false });
    const { findNewerBuild } = await importFresh();
    container.controller = {};

    expect(await findNewerBuild()).toBe(true);
    expect(container.getRegistration).not.toHaveBeenCalled();
  });

  it.each<[string, FakeEnv]>([
    ["the check finds nothing", { waiting: false, update: "nothing" }],
    ["there is no registration", { registration: "none" }],
    ["the check fails", { waiting: false, update: "reject" }],
  ])("finds nothing when %s", async (_label, setup) => {
    installEnvironment(setup);
    const { findNewerBuild } = await importFresh();

    const result = track(findNewerBuild());
    await vi.advanceTimersByTimeAsync(10);

    expect(result.value).toBe(false);
  });

  it("finds nothing without Service Worker support or in the desktop renderer", async () => {
    const { findNewerBuild } = await importFresh();
    expect(await findNewerBuild()).toBe(false);

    installEnvironment();
    (window as unknown as { hushDesktop?: { isDesktop: boolean } }).hushDesktop = { isDesktop: true };
    expect(await findNewerBuild()).toBe(false);
  });
});

describe("skipWaitingNow", () => {
  it("tells the waiting build to take over", async () => {
    const { waiting } = installEnvironment();
    const { skipWaitingNow } = await importFresh();

    expect(await skipWaitingNow()).toBe(true);
    expect(waiting!.postMessage).toHaveBeenCalledOnce();
    expect(waiting!.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it.each<[string, FakeEnv]>([
    ["nothing is waiting", { waiting: false }],
    ["the worker cannot be told", { postThrows: true }],
    ["there is no registration", { registration: "none" }],
  ])("resolves false when %s", async (_label, setup) => {
    installEnvironment(setup);
    const { skipWaitingNow } = await importFresh();

    expect(await skipWaitingNow()).toBe(false);
  });
});

describe("activateWaitingBuild (the person asked to update)", () => {
  it("activates the waiting build and reloads once it has taken control", async () => {
    const { waiting } = installEnvironment();
    const { activateWaitingBuild } = await importFresh();
    const reload = vi.fn();

    await activateWaitingBuild({ reload });

    expect(waiting!.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads after the activation timeout when the new worker never reports control", async () => {
    installEnvironment({ takesControl: false });
    const { activateWaitingBuild, QUIET_UPDATE_ACTIVATE_TIMEOUT_MS } = await importFresh();
    const reload = vi.fn();

    const done = track(activateWaitingBuild({ reload }));
    await vi.advanceTimersByTimeAsync(QUIET_UPDATE_ACTIVATE_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(reload).toHaveBeenCalledOnce();
    expect(done).toEqual({ value: undefined });
  });

  it("reloads at once when nothing is waiting (a newer build already took over)", async () => {
    installEnvironment({ waiting: false });
    const { activateWaitingBuild } = await importFresh();
    const reload = vi.fn();

    await activateWaitingBuild({ reload });

    expect(reload).toHaveBeenCalledOnce();
  });
});
