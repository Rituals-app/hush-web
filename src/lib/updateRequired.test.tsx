/**
 * Tests for the Update Required event bridge, the dialog, the runtime API
 * detector, and the safety guarantees of the fallback update path.
 *
 * The tests are split across describe-blocks so a regression report points
 * at the smallest possible surface. None of the tests boots a real Service
 * Worker; the PWA layer is exercised through dependency injection on
 * `applyUpdate` and through manual events on the global update store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  isDismissibleReason,
  requestUpdate,
  setWaitingUpdateSW,
  type UpdateRequiredDetail,
} from "./updateRequired";
import { foldUpdateRequired, useUpdateRequired } from "../hooks/useUpdateRequired";
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
  // build is ready. Nothing is incompatible, so the copy says so, and the
  // person may put it off.
  it("offers the newer build when part of this build failed to load", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Update ready" })).toBeInTheDocument();
    expect(
      screen.getByText("A newer version of this space is ready. Updating reloads this space and any other open Space tabs."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/critical update/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("puts the newer build off with Later, and offers it again on the next failure", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByTestId("update-required-dialog")).toBeNull());

    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    expect(await screen.findByTestId("update-required-dialog")).toBeInTheDocument();
  });

  it("puts the newer build off with Escape", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    fireEvent.keyDown(await screen.findByTestId("update-required-dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("update-required-dialog")).toBeNull());
  });

  it("a critical update replaces the newer-build offer and cannot be put off", async () => {
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    await screen.findByRole("heading", { name: "Update ready" });
    await act(async () => {
      requestUpdate({ reason: "min-client-version" });
    });
    expect(screen.getByRole("heading", { name: /update required/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();

    // And the offer never replaces it.
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    expect(screen.getByRole("heading", { name: /update required/i })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("update-required-dialog"), { key: "Escape" });
    expect(screen.getByTestId("update-required-dialog")).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    // Still mounted after Escape.
    expect(screen.getByTestId("update-required-dialog")).toBeInTheDocument();
  });
});

// Rituals fork (2026-11-06): the dialog opens by itself, often mid-typing. It
// must not put focus on a button the next keystroke could press, and it gives
// the text field its focus back when it closes.
describe("UpdateRequiredDialog focus", () => {
  const fields: HTMLElement[] = [];

  /** A focused text field outside React, so a test can remove it. */
  function focusedField(value = ""): HTMLInputElement {
    const field = document.createElement("input");
    field.value = value;
    document.body.append(field);
    fields.push(field);
    field.focus();
    return field;
  }

  async function raise(reason: UpdateRequiredDetail["reason"]) {
    await act(async () => {
      requestUpdate({ reason });
    });
    return screen.findByTestId("update-required-dialog");
  }

  async function openWhileTyping(reason: UpdateRequiredDetail["reason"], value = "") {
    const field = focusedField(value);
    render(<UpdateRequiredDialog />);
    await flushEffects();
    return { field, dialog: await raise(reason) };
  }

  const later = () => screen.getByRole("button", { name: "Later" });
  const update = () => screen.getByRole("button", { name: "Update" });

  async function closed() {
    await waitFor(() => expect(screen.queryByTestId("update-required-dialog")).toBeNull());
    // Radix hands focus back on a timer after the dialog has gone.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** jsdom says a page has focus only while an element does; a browser means the keyboard. */
  function pageHasKeyboard(answer: boolean) {
    vi.spyOn(document, "hasFocus").mockReturnValue(answer);
  }

  /** The browser's event when this window or frame gets the keyboard. */
  function keyboardComesBack() {
    pageHasKeyboard(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
  }

  /**
   * Text selected in the page, as an editor's caret is. Returns a watch on the
   * clear: jsdom's focus() moves the selection by itself, so what it ends up as
   * says nothing here.
   */
  function selectSomething() {
    const text = document.createElement("p");
    text.textContent = "selected";
    document.body.append(text);
    fields.push(text);
    const selection = document.getSelection() as Selection;
    selection.selectAllChildren(text);
    return vi.spyOn(selection, "removeAllRanges");
  }

  beforeEach(() => {
    pageHasKeyboard(true);
  });

  afterEach(() => {
    fields.splice(0).forEach((field) => field.remove());
    document.getSelection()?.removeAllRanges();
    // A press, as a real next key would be, so no close outlives its test.
    fireEvent.keyDown(window, { key: "Shift" });
  });

  it("sends the offer's focus to the dialog itself, and Tab reaches its buttons", async () => {
    const user = userEvent.setup();
    const { dialog } = await openWhileTyping("chunk-load-failed");

    expect(document.activeElement).toBe(dialog);
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(dialog).toHaveAttribute("role", "alertdialog");

    await user.tab();
    expect(document.activeElement).toBe(later());
    await user.tab();
    expect(document.activeElement).toBe(update());
    await user.tab();
    expect(document.activeElement).toBe(later());
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(update());
  });

  it("a keystroke meant for the text field presses nothing and types nothing", async () => {
    const user = userEvent.setup();
    const { field, dialog } = await openWhileTyping("chunk-load-failed", "half a thought");

    for (const key of [" ", "{Enter}", "a"]) {
      await user.keyboard(key);
      expect(document.activeElement).toBe(dialog);
      expect(dialog).toHaveAttribute("data-state", "open");
      expect(update()).toBeEnabled();
      expect(update()).toHaveTextContent("Update");
    }
    expect(field.value).toBe("half a thought");
  });

  it.each(["Later", "Escape"])("gives the text field its focus and caret back after %s", async (how) => {
    const user = userEvent.setup();
    const field = focusedField("half a thought");
    field.setSelectionRange(4, 4);
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await raise("chunk-load-failed");
    expect(document.activeElement).not.toBe(field);

    if (how === "Later") await user.click(later());
    else await user.keyboard("{Escape}");
    await closed();

    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4]);
    await user.keyboard("x");
    expect(field.value).toBe("halfx a thought");
  });

  it("asks for focus only of a field that is still on the page", async () => {
    const { field } = await openWhileTyping("chunk-load-failed");
    const focus = vi.spyOn(field, "focus");
    field.remove();

    fireEvent.click(later());
    await closed();

    expect(focus).not.toHaveBeenCalled();
  });

  it("remembers the field anew each time the offer opens", async () => {
    const { field } = await openWhileTyping("chunk-load-failed");
    fireEvent.click(later());
    await closed();
    expect(document.activeElement).toBe(field);

    const other = focusedField();
    await raise("chunk-load-failed");
    fireEvent.click(later());
    await closed();

    expect(document.activeElement).toBe(other);
  });

  it("a critical update takes focus from the field behind it, and not to Update", async () => {
    const user = userEvent.setup();
    const { field, dialog } = await openWhileTyping("api-426", "half a thought");

    expect(document.activeElement).toBe(dialog);
    for (const key of [" ", "{Enter}", "a"]) {
      await user.keyboard(key);
      expect(document.activeElement).toBe(dialog);
      expect(update()).toBeEnabled();
    }
    expect(field.value).toBe("half a thought");

    await user.tab();
    expect(document.activeElement).toBe(update());
  });

  it("keeps focus in the dialog when a critical update replaces the offer while Later has it", async () => {
    const user = userEvent.setup();
    const { dialog } = await openWhileTyping("chunk-load-failed");
    await user.tab();
    expect(document.activeElement).toBe(later());

    await raise("api-426");

    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it("clears the selection as it takes focus: WebKit keeps typing at one in an editor", async () => {
    focusedField();
    const clearSelection = selectSomething();
    render(<UpdateRequiredDialog />);
    await flushEffects();

    const dialog = await raise("chunk-load-failed");

    expect(document.activeElement).toBe(dialog);
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  // In a frame, the person may be typing in the page around it. focus() from a
  // timer would take the keyboard from them.
  describe("when the page does not have the keyboard", () => {
    it.each<UpdateRequiredDetail["reason"]>(["chunk-load-failed", "api-426"])(
      "leaves focus and selection alone until it does (%s)",
      async (reason) => {
        pageHasKeyboard(false);
        const field = focusedField("half a thought");
        const clearSelection = selectSomething();
        render(<UpdateRequiredDialog />);
        await flushEffects();

        const dialog = await raise(reason);

        expect(dialog).toHaveAttribute("data-state", "open");
        expect(document.activeElement).toBe(field);
        expect(clearSelection).not.toHaveBeenCalled();
      },
    );

    it.each<UpdateRequiredDetail["reason"]>(["chunk-load-failed", "api-426"])(
      "takes focus when the keyboard comes back, so Tab stays inside (%s)",
      async (reason) => {
        pageHasKeyboard(false);
        const user = userEvent.setup();
        const field = focusedField("half a thought");
        const clearSelection = selectSomething();
        render(<UpdateRequiredDialog />);
        await flushEffects();
        const dialog = await raise(reason);

        keyboardComesBack();

        expect(document.activeElement).toBe(dialog);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        await user.tab();
        expect(document.activeElement).toBe(reason === "api-426" ? update() : later());
        expect(field.value).toBe("half a thought");
      },
    );

    it("takes focus only the first time the keyboard comes back", async () => {
      pageHasKeyboard(false);
      const user = userEvent.setup();
      focusedField();
      render(<UpdateRequiredDialog />);
      await flushEffects();
      await raise("chunk-load-failed");
      keyboardComesBack();
      await user.tab();
      expect(document.activeElement).toBe(later());

      keyboardComesBack();
      fireEvent.keyDown(later(), { key: "a" });

      expect(document.activeElement).toBe(later());
    });

    it("stops waiting for the keyboard once the dialog has closed", async () => {
      pageHasKeyboard(false);
      focusedField();
      render(<UpdateRequiredDialog />);
      await flushEffects();
      await raise("chunk-load-failed");
      fireEvent.click(later());
      await closed();
      const clearSelection = selectSomething();

      keyboardComesBack();
      fireEvent.keyDown(document.body, { key: "a" });

      expect(clearSelection).not.toHaveBeenCalled();
    });

    // Firefox raises no focus event in a frame when Tab brings the keyboard in,
    // and Tab from there went to a control behind the dialog.
    describe("when the keyboard arrives with no focus event", () => {
      it.each(["Tab", "Enter", "a"])("takes focus at the first key, %s, before it does anything", async (key) => {
        pageHasKeyboard(false);
        const field = focusedField("half a thought");
        const clearSelection = selectSomething();
        render(<UpdateRequiredDialog />);
        await flushEffects();
        const dialog = await raise("api-426");
        pageHasKeyboard(true);

        const seenByFocus: Array<Element | null> = [];
        const watch = () => seenByFocus.push(document.activeElement);
        document.body.addEventListener("keydown", watch);
        fireEvent.keyDown(document.body, { key });
        document.body.removeEventListener("keydown", watch);

        expect(seenByFocus).toEqual([dialog]);
        expect(document.activeElement).toBe(dialog);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        expect(update()).toBeEnabled();
        expect(field.value).toBe("half a thought");
      });

      it("takes focus only once, whichever way the keyboard came", async () => {
        pageHasKeyboard(false);
        const user = userEvent.setup();
        focusedField();
        render(<UpdateRequiredDialog />);
        await flushEffects();
        await raise("chunk-load-failed");
        pageHasKeyboard(true);
        fireEvent.keyDown(document.body, { key: "a" });
        await user.tab();
        expect(document.activeElement).toBe(later());

        keyboardComesBack();
        fireEvent.keyDown(later(), { key: "a" });

        expect(document.activeElement).toBe(later());
      });
    });

    // src/lib/ritualsSpace.js turns an Escape pressed in the parent page into a
    // keydown in this frame. The person's keyboard stays out there.
    describe("the Escape the parent page forwards", () => {
      const forwardEscape = () =>
        fireEvent.keyDown(document.activeElement as Element, { key: "Escape", code: "Escape" });

      it("does not count as the keyboard arriving", async () => {
        pageHasKeyboard(false);
        const field = focusedField("half a thought");
        const clearSelection = selectSomething();
        render(<UpdateRequiredDialog />);
        await flushEffects();
        const dialog = await raise("api-426");

        forwardEscape();

        expect(dialog).toHaveAttribute("data-state", "open");
        expect(document.activeElement).toBe(field);
        expect(clearSelection).not.toHaveBeenCalled();

        keyboardComesBack();
        expect(document.activeElement).toBe(dialog);
      });

      it("puts the offer off and leaves the keyboard with the person", async () => {
        pageHasKeyboard(false);
        const field = focusedField("half a thought");
        const focus = vi.spyOn(field, "focus");
        render(<UpdateRequiredDialog />);
        await flushEffects();
        await raise("chunk-load-failed");

        forwardEscape();
        await closed();

        expect(focus).not.toHaveBeenCalled();
      });
    });

    // A window left for another app keeps its focused field; a frame left for the
    // page around it does not, so there this hands back nothing.
    it("gives the field its focus back once the keyboard has returned", async () => {
      pageHasKeyboard(false);
      const field = focusedField("draft");
      render(<UpdateRequiredDialog />);
      await flushEffects();
      await raise("chunk-load-failed");
      keyboardComesBack();
      expect(document.activeElement).not.toBe(field);

      fireEvent.click(later());
      await closed();

      expect(document.activeElement).toBe(field);
    });

    it("does not take the keyboard back on closing, once the person has moved away", async () => {
      const { field } = await openWhileTyping("chunk-load-failed", "half a thought");
      const focus = vi.spyOn(field, "focus");
      fireEvent.click(later());
      pageHasKeyboard(false);

      await closed();

      expect(focus).not.toHaveBeenCalled();
    });
  });

  // Enter presses Later on its way down. The field has its focus back before the
  // key's first auto-repeat, and Enter sends in the composer.
  describe("a key still held when the dialog closes", () => {
    function watchKeys(field: HTMLElement) {
      const reached = vi.fn();
      field.addEventListener("keydown", reached);
      return reached;
    }

    const repeat = (element: HTMLElement, key: string) => fireEvent.keyDown(element, { key, repeat: true });

    async function holdEnterOnLater() {
      const user = userEvent.setup();
      const { field } = await openWhileTyping("chunk-load-failed", "half a thought");
      await user.tab();
      expect(document.activeElement).toBe(later());
      await user.keyboard("{Enter>}");
      await closed();
      expect(document.activeElement).toBe(field);
      return { user, field, reached: watchKeys(field) };
    }

    it("does not repeat into the field that got its focus back", async () => {
      const { field, reached } = await holdEnterOnLater();

      // false: the browser's action for the key is cancelled too.
      expect(repeat(field, "Enter")).toBe(false);
      expect(repeat(field, "Enter")).toBe(false);

      expect(reached).not.toHaveBeenCalled();
    });

    it("does not repeat into the field after Escape either", async () => {
      const user = userEvent.setup();
      const { field } = await openWhileTyping("chunk-load-failed", "half a thought");
      await user.keyboard("{Escape>}");
      await closed();
      expect(document.activeElement).toBe(field);
      const reached = watchKeys(field);

      expect(repeat(field, "Escape")).toBe(false);

      expect(reached).not.toHaveBeenCalled();
    });

    it("still holds after another key comes up, as Option does after Option+Tab", async () => {
      const { field, reached } = await holdEnterOnLater();

      fireEvent.keyUp(field, { key: "Alt" });

      expect(repeat(field, "Enter")).toBe(false);
      expect(reached).not.toHaveBeenCalled();
    });

    it("lets the next press through, and that press's own repeats", async () => {
      const { user, field, reached } = await holdEnterOnLater();
      expect(repeat(field, "Enter")).toBe(false);
      await user.keyboard("{/Enter}");

      expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
      expect(repeat(field, "Enter")).toBe(true);

      expect(reached).toHaveBeenCalledTimes(2);
    });

    it("costs a hold after a mouse close nothing: no key was down when it closed", async () => {
      const { field } = await openWhileTyping("chunk-load-failed", "half a thought");
      fireEvent.click(later());
      await closed();
      const reached = watchKeys(field);

      expect(fireEvent.keyDown(field, { key: "Backspace" })).toBe(true);
      expect(repeat(field, "Backspace")).toBe(true);
      expect(repeat(field, "Backspace")).toBe(true);

      expect(reached).toHaveBeenCalledTimes(3);
    });
  });
});

// Rituals fork (2026-11-06): the dialog stays mounted while it animates out, so
// the words on it must not change until it has gone.
describe("UpdateRequiredDialog while it closes", () => {
  /**
   * jsdom runs no CSS animation, so the dialog would be removed at once. This
   * reports the exit animation Radix waits for, as a browser's live styles do.
   */
  function animateClosing() {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) =>
      new Proxy(real(element, pseudo), {
        get: (styles, key) =>
          key === "animationName"
            ? (element as HTMLElement).dataset.state === "closed" ? "exit" : "none"
            : Reflect.get(styles, key),
      }),
    );
  }

  it.each(["Later", "Escape"])("keeps the offer's words on screen while it animates out after %s", async (how) => {
    animateClosing();
    render(<UpdateRequiredDialog />);
    await flushEffects();
    await act(async () => {
      requestUpdate({ reason: "chunk-load-failed" });
    });
    const dialog = await screen.findByTestId("update-required-dialog");

    if (how === "Later") fireEvent.click(screen.getByTestId("update-required-later"));
    else fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).toHaveAttribute("data-state", "closed"));
    expect(dialog).toHaveTextContent("Update ready");
    expect(dialog).toHaveTextContent("A newer version of this space is ready.");
    expect(dialog).not.toHaveTextContent(/update required|critical/i);
    expect(screen.getByTestId("update-required-later")).toBeInTheDocument();
  });
});

describe("useUpdateRequired", () => {
  it("keeps the last reason when the person puts the offer off, and opens again on the next event", async () => {
    const { result } = renderHook(() => useUpdateRequired());
    await flushEffects();

    act(() => requestUpdate({ reason: "chunk-load-failed" }));
    expect(result.current).toMatchObject({ open: true, reason: "chunk-load-failed" });

    act(() => result.current.dismiss());
    expect(result.current).toMatchObject({ open: false, reason: "chunk-load-failed" });

    act(() => requestUpdate({ reason: "chunk-load-failed" }));
    expect(result.current).toMatchObject({ open: true, reason: "chunk-load-failed" });
  });

  it("opens as a critical update after an offer was put off", async () => {
    const { result } = renderHook(() => useUpdateRequired());
    await flushEffects();
    act(() => requestUpdate({ reason: "chunk-load-failed" }));
    act(() => result.current.dismiss());

    act(() => requestUpdate({ reason: "api-426" }));
    expect(result.current).toMatchObject({ open: true, reason: "api-426" });

    // A critical one cannot be put off.
    act(() => result.current.dismiss());
    expect(result.current).toMatchObject({ open: true, reason: "api-426" });
  });

  it("does nothing when dismissed while closed", async () => {
    const { result } = renderHook(() => useUpdateRequired());
    await flushEffects();

    act(() => result.current.dismiss());

    expect(result.current).toMatchObject({ open: false, reason: null });
  });
});

// Rituals fork (2026-11-06): which reasons may be put off, and how events fold.
describe("dismissible reasons", () => {
  it("only the newer-build offer may be put off", () => {
    expect(isDismissibleReason("chunk-load-failed")).toBe(true);
    for (const reason of [
      "sw-need-refresh",
      "min-client-version",
      "ciphersuite-mismatch",
      "api-426",
      "api-mls-ciphersuite-mismatch",
      "api-compat-error",
    ] as const) {
      expect(isDismissibleReason(reason), reason).toBe(false);
    }
    expect(isDismissibleReason(null)).toBe(false);
    expect(isDismissibleReason(undefined)).toBe(false);
  });

  it("folds events: the first opens, a critical one replaces an offer, nothing else changes it", () => {
    const closed = { open: false, reason: null };
    const offer = foldUpdateRequired(closed, "chunk-load-failed");
    expect(offer).toEqual({ open: true, reason: "chunk-load-failed" });
    expect(foldUpdateRequired(offer, "chunk-load-failed")).toBe(offer);

    const critical = foldUpdateRequired(offer, "api-426");
    expect(critical).toEqual({ open: true, reason: "api-426" });
    expect(foldUpdateRequired(critical, "chunk-load-failed")).toBe(critical);
    expect(foldUpdateRequired(critical, "min-client-version")).toBe(critical);

    // An event without a reason counts as critical.
    expect(foldUpdateRequired(offer, null)).toEqual({ open: true, reason: null });
  });

  it("a closed dialog opens with the new reason, whatever reason it last showed", () => {
    const closedOffer = { open: false, reason: "chunk-load-failed" } as const;

    expect(foldUpdateRequired(closedOffer, "chunk-load-failed")).toEqual({ open: true, reason: "chunk-load-failed" });
    expect(foldUpdateRequired(closedOffer, "api-426")).toEqual({ open: true, reason: "api-426" });
    expect(foldUpdateRequired(closedOffer, null)).toEqual({ open: true, reason: null });
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

  // Rituals fork (2026-11-06): nothing was waiting, so no controller change
  // will come; waiting out the timeout would only delay the reload.
  it("reloads at once when the updater says nothing was waiting", async () => {
    setWaitingUpdateSW(vi.fn().mockResolvedValue(false));
    const swContainer = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer;
    const reload = vi.fn();
    const timeout = vi.spyOn(globalThis, "setTimeout");

    await applyUpdate({
      location: { reload } as unknown as Location,
      serviceWorker: swContainer,
      controllerChangeTimeoutMs: 60_000,
    });

    expect(reload).toHaveBeenCalledOnce();
    // The 60 s timer may be armed, but the reload did not wait for it.
    expect(timeout.mock.calls.some(([, ms]) => ms === 60_000)).toBe(true);
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
