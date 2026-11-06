import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Rituals fork (2026-11-06): the boot-time update step (src/lib/quietUpdate.ts).
// navigator.serviceWorker and navigator.locks are fakes: jsdom has neither.

type Grant = "now" | "late" | "never" | "reject";
type RegistrationMode = "present" | "none" | "hang" | "reject";

interface FakeEnv {
  controlled?: boolean;
  registration?: RegistrationMode;
  waiting?: boolean;
  /** The new worker takes control right after SKIP_WAITING. */
  takesControl?: boolean;
  postThrows?: boolean;
  waitingGetterThrows?: boolean;
  locks?: boolean;
  grant?: Grant;
  otherHeld?: number;
  otherPending?: number;
}

const NOW = 1_800_000_000_000;
const PRESENCE = "hush_sw_page_presence";

function installEnvironment(env: FakeEnv = {}) {
  const listeners = new Set<() => void>();
  const fireControllerChange = () => [...listeners].forEach((listener) => listener());

  const waiting = env.waiting === false
    ? null
    : {
        postMessage: vi.fn(() => {
          if (env.postThrows) throw new Error("worker gone");
          if (env.takesControl !== false) void Promise.resolve().then(fireControllerChange);
        }),
      };
  const registration = env.waitingGetterThrows
    ? Object.defineProperty({}, "waiting", { get: () => { throw new Error("broken"); } })
    : { waiting };

  const container = {
    controller: env.controlled === false ? null : {},
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
    query: vi.fn(async () => ({
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

  return { container, waiting, locks };
}

let diagnostics: { event?: string; details?: { outcome?: string } }[];
const onDiagnostic = (event: Event) => diagnostics.push((event as CustomEvent).detail);

async function importFresh() {
  vi.resetModules();
  return import("./quietUpdate");
}

/** Runs the boot step with the clock advanced far enough for every timeout. */
async function runToEnd() {
  const { applyWaitingBuildAtStart } = await importFresh();
  const reload = vi.fn();
  const promise = applyWaitingBuildAtStart({ reload });
  await vi.advanceTimersByTimeAsync(10_000);
  return { outcome: await promise, reload };
}

function bootOutcomes() {
  return diagnostics.filter((detail) => detail?.event === "sw-boot-update").map((detail) => detail.details?.outcome);
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
