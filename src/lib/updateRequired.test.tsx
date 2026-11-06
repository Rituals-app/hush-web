/**
 * Tests for the Update Required event bridge, the dialog, the runtime API
 * detector, and the safety guarantees of the fallback update path.
 *
 * The tests are split across describe-blocks so a regression report points
 * at the smallest possible surface. None of the tests boots a real Service
 * Worker; the PWA layer is exercised through dependency injection on
 * `applyUpdate` and through manual events on the global update store.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";

// Flush React's microtask queue so a freshly-mounted component has had a
// chance to run its `useEffect` (e.g. to subscribe to the global update
// event) before the test dispatches that event.
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

import {
  NEVER_CACHE_URL_PATTERNS,
  NAVIGATE_FALLBACK_DENYLIST,
  PWA_OPTIONS,
  RUNTIME_CACHING,
  filterPrecacheManifest,
  shouldPrecacheUrl,
} from "./pwaWorkboxOptions";
import {
  UPDATE_REQUIRED_EVENT,
  applyUpdate,
  getWaitingUpdateSW,
  requestUpdate,
  setWaitingUpdateSW,
} from "./updateRequired";
import { evaluateHandshakeCompatibility } from "./handshakeCompatibility";
import { CLIENT_VERSION, isClientBelowMinimum } from "./clientVersion";
import {
  CURRENT_MLS_CIPHERSUITE,
  MLSCiphersuiteMismatchError,
} from "./mlsCiphersuite";
import { fetchWithAuth } from "./api";
import UpdateRequiredDialog from "../components/UpdateRequiredDialog";

function nextAlphaVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/);
  if (!match) return "999.0.0-alpha.1";

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const alpha = match[4] ? Number(match[4]) : null;

  if (alpha != null) return `${major}.${minor}.${patch}-alpha.${alpha + 1}`;
  return `${major}.${minor}.${patch + 1}-alpha.1`;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function recordEvents(): { events: CustomEvent[]; stop: () => void } {
  const events: CustomEvent[] = [];
  function listener(ev: Event) {
    events.push(ev as CustomEvent);
  }
  window.addEventListener(UPDATE_REQUIRED_EVENT, listener);
  return {
    events,
    stop: () => window.removeEventListener(UPDATE_REQUIRED_EVENT, listener),
  };
}

afterEach(() => {
  // Vitest runs with `globals: false`, so @testing-library/react does not
  // auto-cleanup. Without this the AlertDialog portals stack across tests
  // and the queries match multiple instances.
  cleanup();
  setWaitingUpdateSW(null);
  vi.restoreAllMocks();
});

// ── SW configuration ─────────────────────────────────────────────────────────

describe("PWA Workbox config", () => {
  it("never runtime-caches /api, /ws, /livekit, /admin, or attachment paths", () => {
    const samples = [
      "/api/handshake",
      "/api/mls/credentials",
      "/api/mls/groups/abc/info",
      "/api/mls/groups/abc/commit",
      "/api/attachments/123/download",
      "/api/servers/abc/channels/def/attachments/presign",
      "/ws",
      "/ws?token=xyz",
      "/livekit/room",
      "/admin/",
      "/admin/assets/index.js",
    ];
    for (const s of samples) {
      const matches = NEVER_CACHE_URL_PATTERNS.some((re) => re.test(s));
      expect(matches, `expected ${s} to match a never-cache pattern`).toBe(true);
    }
  });

  it("excludes /api, /ws, /livekit, and /admin from navigateFallback", () => {
    const samples = ["/api/handshake", "/ws", "/livekit/foo", "/admin/"];
    for (const s of samples) {
      const matches = NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(s));
      expect(matches).toBe(true);
    }
  });

  it("runtime caching rule rejects API/WS/LiveKit/admin destinations", () => {
    const rule = RUNTIME_CACHING[0];
    expect(rule.handler).toBe("NetworkFirst");
    const apiUrl = new URL("https://example.test/api/handshake");
    const wsUrl = new URL("https://example.test/ws");
    const lkUrl = new URL("https://example.test/livekit/room");
    const adminUrl = new URL("https://example.test/admin/");
    expect(
      rule.urlPattern({ request: { destination: "document" }, url: apiUrl }),
    ).toBe(false);
    expect(
      rule.urlPattern({ request: { destination: "document" }, url: wsUrl }),
    ).toBe(false);
    expect(
      rule.urlPattern({ request: { destination: "document" }, url: lkUrl }),
    ).toBe(false);
    expect(
      rule.urlPattern({ request: { destination: "document" }, url: adminUrl }),
    ).toBe(false);
  });

  it("does not skip waiting or claim clients automatically", () => {
    // The Update Required dialog is the only legal activator. Auto-claim
    // could swap the bundle mid-MLS-commit.
    expect(PWA_OPTIONS.workbox.skipWaiting).toBe(false);
    expect(PWA_OPTIONS.workbox.clientsClaim).toBe(false);
    expect(PWA_OPTIONS.registerType).toBe("prompt");
  });

  it("never enables PWA in dev mode (HMR collides with SW interception)", () => {
    expect(PWA_OPTIONS.devOptions.enabled).toBe(false);
  });

  it("precache allowlist keeps the offline shell small and excludes lazy/dev chunks", () => {
    const allowed = [
      "index.html",
      "manifest.webmanifest",
      "favicon.png",
      "icon-512-light.png",
      "hush-logo.svg",
      "assets/index-AbCd_12.js",
      "assets/index-AbCd_12.css",
      "assets/vendor-react-AbCd_12.js",
      "assets/hush_crypto-AbCd_12.js",
      "assets/hush_crypto_bg-AbCd_12.wasm",
      "assets/geist-latin-wght-normal-AbCd_12.woff2",
      "assets/workbox-window.prod.es5-AbCd_12.js",
    ];
    const blocked = [
      "og.png",
      "assets/eruda-AbCd_12.js",
      "assets/livekit-client.e2ee.worker-AbCd_12.js",
      "assets/mermaid-AbCd_12.js",
      "assets/vendor-motion-AbCd_12.js",
      "assets/typescript-AbCd_12.js",
      "assets/ApproveDeviceLinkFlow-AbCd_12.js",
    ];

    for (const url of allowed) {
      expect(shouldPrecacheUrl(url), `expected ${url} to be app-shell cached`).toBe(true);
    }
    for (const url of blocked) {
      expect(shouldPrecacheUrl(url), `expected ${url} to stay out of precache`).toBe(false);
    }
  });

  it("filters Workbox's generated manifest to the app shell only", () => {
    const input = [
      { url: "index.html", revision: "1" },
      { url: "assets/index-AbCd_12.js", revision: "1" },
      { url: "assets/vendor-react-AbCd_12.js", revision: "1" },
      { url: "assets/index-AbCd_12.js", revision: "1" },
      { url: "assets/eruda-AbCd_12.js", revision: "1" },
      { url: "assets/mermaid-AbCd_12.js", revision: "1" },
    ];

    expect(filterPrecacheManifest(input).manifest).toEqual(input.slice(0, 3));
  });
});

// ── Update-required event bridge ─────────────────────────────────────────────

describe("requestUpdate event", () => {
  it("dispatches a CustomEvent carrying the reason", () => {
    const { events, stop } = recordEvents();
    requestUpdate({ reason: "sw-need-refresh" });
    expect(events).toHaveLength(1);
    expect(events[0].detail.reason).toBe("sw-need-refresh");
    stop();
  });
});

// ── UpdateRequiredDialog ─────────────────────────────────────────────────────

describe("UpdateRequiredDialog", () => {
  it("does not render before any update event", () => {
    render(<UpdateRequiredDialog />);
    expect(screen.queryByTestId("update-required-dialog")).toBeNull();
  });

  it("renders when the PWA needRefresh event fires", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "sw-need-refresh" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /update required/i })).toBeInTheDocument();
  });

  // Rituals fork (2026-11-06): part of this build failed to load and a newer
  // build is ready. Nothing is incompatible, so the copy says so.
  it("asks to load the newer build when part of this build failed to load", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Update needed" })).toBeInTheDocument();
    expect(
      screen.getByText("A newer version of this space is ready. Updating reloads this space and any other open Space tabs."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/critical update/i)).toBeNull();
  });

  it("renders on min_client_version mismatch", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      evaluateHandshakeCompatibility({ min_client_version: "999.0.0" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("renders on current_mls_ciphersuite mismatch", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      evaluateHandshakeCompatibility({ current_mls_ciphersuite: 1 });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("renders on API 426 Upgrade Required", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 426,
      clone() {
        return {
          json: () => Promise.resolve({}),
        };
      },
      json: () => Promise.resolve({}),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch as typeof fetch);

    await act(async () => {
      await fetchWithAuth("tok", "/api/whatever");
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("renders on mls_ciphersuite_mismatch response body", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();

    const body = { error: "mls_ciphersuite_mismatch", declared: 1, current_ciphersuite: 77 };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      clone() {
        return { json: () => Promise.resolve(body) };
      },
      json: () => Promise.resolve(body),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch as typeof fetch);

    await act(async () => {
      await fetchWithAuth("tok", "/api/mls/key-packages", { method: "POST" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("renders on ciphersuite-required response body", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();

    const body = { error: "ciphersuite is required; current server suite is 77" };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        clone() {
          return { json: () => Promise.resolve(body) };
        },
        json: () => Promise.resolve(body),
      }) as typeof fetch,
    );

    await act(async () => {
      await fetchWithAuth("tok", "/api/mls/key-packages", { method: "POST" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("renders on alpha prerelease min_client_version bump", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      evaluateHandshakeCompatibility({
        min_client_version: nextAlphaVersion(CLIENT_VERSION),
      });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("the dialog cannot be dismissed via Escape / outside click", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "sw-need-refresh" });
    });
    const dialog = await screen.findByTestId("update-required-dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    // Still mounted after Escape.
    expect(screen.getByTestId("update-required-dialog")).toBeInTheDocument();
  });
});

// ── handshakeCompatibility helper ────────────────────────────────────────────

describe("evaluateHandshakeCompatibility", () => {
  it("ignores a handshake that matches the running client", () => {
    const { events, stop } = recordEvents();
    evaluateHandshakeCompatibility({
      min_client_version: "0.0.1",
      current_mls_ciphersuite: CURRENT_MLS_CIPHERSUITE,
    });
    expect(events).toHaveLength(0);
    stop();
  });

  it("tolerates a server that does not advertise the field", () => {
    const { events, stop } = recordEvents();
    evaluateHandshakeCompatibility({ server_version: "0.6.0" } as never);
    expect(events).toHaveLength(0);
    stop();
  });

  it("dispatches on min_client_version above the running client", () => {
    const { events, stop } = recordEvents();
    evaluateHandshakeCompatibility({ min_client_version: "999.0.0" });
    expect(events).toHaveLength(1);
    expect(events[0].detail.reason).toBe("min-client-version");
    stop();
  });

  it("compares prerelease identifiers instead of ignoring alpha bumps", () => {
    expect(isClientBelowMinimum("0.7.0-alpha.15", "0.7.0-alpha.14")).toBe(true);
    expect(isClientBelowMinimum("0.7.0-alpha.14", "0.7.0-alpha.14")).toBe(false);
    expect(isClientBelowMinimum("0.7.0-alpha.13", "0.7.0-alpha.14")).toBe(false);
    expect(isClientBelowMinimum("0.7.0", "0.7.0-alpha.14")).toBe(true);
    expect(isClientBelowMinimum("0.7.0-alpha.13", "0.7.0")).toBe(false);
  });

  it("dispatches on ciphersuite mismatch", () => {
    const { events, stop } = recordEvents();
    evaluateHandshakeCompatibility({ current_mls_ciphersuite: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].detail.reason).toBe("ciphersuite-mismatch");
    stop();
  });
});

// ── applyUpdate (SW path + fallback) ─────────────────────────────────────────

describe("applyUpdate — SW path", () => {
  it("activates a waiting SW and reloads on controllerchange", async () => {
    const updateSW = vi.fn().mockResolvedValue(undefined);
    setWaitingUpdateSW(updateSW);

    const listeners = new Map<string, () => void>();
    const swContainer = {
      addEventListener: vi.fn((evt: string, cb: () => void) => {
        listeners.set(evt, cb);
      }),
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer;

    const reload = vi.fn();
    const loc = { reload } as unknown as Location;

    // Resolve the controllerchange "race" by firing the event after the
    // updater is invoked.
    const promise = applyUpdate({
      location: loc,
      serviceWorker: swContainer,
      controllerChangeTimeoutMs: 1000,
    });

    // Allow microtasks so the listener is wired up before we fire.
    await Promise.resolve();
    listeners.get("controllerchange")?.();

    await promise;

    expect(updateSW).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("times out and reloads anyway if controllerchange never fires", async () => {
    const updateSW = vi.fn().mockResolvedValue(undefined);
    setWaitingUpdateSW(updateSW);

    const swContainer = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer;

    const reload = vi.fn();
    await applyUpdate({
      location: { reload } as unknown as Location,
      serviceWorker: swContainer,
      controllerChangeTimeoutMs: 5,
    });

    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("applyUpdate — fallback path", () => {
  it("does not clear Cache API entries, leaves localStorage untouched, and reloads", async () => {
    setWaitingUpdateSW(null);

    const keys = vi.fn().mockResolvedValue(["v1", "v2"]);
    const del = vi.fn().mockResolvedValue(true);
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { keys, delete: del },
    });

    const reload = vi.fn();
    const clearSpy = vi.spyOn(Storage.prototype, "clear");
    const removeSpy = vi.spyOn(Storage.prototype, "removeItem");

    // Seed a token so we can assert it survived the update.
    localStorage.setItem("__test_token", "abc");

    try {
      await applyUpdate({
        location: { reload } as unknown as Location,
        serviceWorker: undefined,
      });
    } finally {
      if (originalCaches) {
        Object.defineProperty(globalThis, "caches", originalCaches);
      } else {
        delete (globalThis as { caches?: unknown }).caches;
      }
    }

    expect(keys).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("__test_token")).toBe("abc");
    expect(reload).toHaveBeenCalledOnce();
    localStorage.removeItem("__test_token");
  });

  it("does not delete any IndexedDB databases", async () => {
    setWaitingUpdateSW(null);

    const reload = vi.fn();
    const deleteDatabaseSpy = vi.fn();
    // fake-indexeddb provides indexedDB on jsdom; we just observe.
    const original = globalThis.indexedDB?.deleteDatabase?.bind(globalThis.indexedDB);
    if (globalThis.indexedDB) {
      // Wrap deleteDatabase to record any call.
      globalThis.indexedDB.deleteDatabase = ((name: string) => {
        deleteDatabaseSpy(name);
        if (original) return original(name);
        return {} as IDBOpenDBRequest;
      }) as typeof globalThis.indexedDB.deleteDatabase;
    }

    await applyUpdate({
      location: { reload } as unknown as Location,
      serviceWorker: undefined,
    });

    expect(deleteDatabaseSpy).not.toHaveBeenCalled();
  });
});

// ── setWaitingUpdateSW / getWaitingUpdateSW ──────────────────────────────────

describe("setWaitingUpdateSW", () => {
  it("round-trips through the getter", () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    setWaitingUpdateSW(fn);
    expect(getWaitingUpdateSW()).toBe(fn);
    setWaitingUpdateSW(null);
    expect(getWaitingUpdateSW()).toBeNull();
  });
});

// ── Defence: importing pwaUpdate must not blow up under vitest ───────────────

describe("pwaUpdate import safety", () => {
  it("can be imported in jsdom without throwing", async () => {
    const mod = await import("./pwaUpdate");
    expect(() => mod.registerPWA()).not.toThrow();
  });
});

// ── Cross-link: mlsCiphersuite mismatch still throws for early gate ──────────

describe("MLSCiphersuiteMismatchError integration", () => {
  it("is still exported and instance-checkable", () => {
    const err = new MLSCiphersuiteMismatchError(1);
    expect(err).toBeInstanceOf(MLSCiphersuiteMismatchError);
    expect(err.serverCiphersuite).toBe(1);
    expect(err.clientCiphersuite).toBe(CURRENT_MLS_CIPHERSUITE);
  });
});
