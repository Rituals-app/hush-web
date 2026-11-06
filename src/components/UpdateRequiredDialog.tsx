import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useUpdateRequired } from "@/hooks/useUpdateRequired";
import { applyUpdate, isDismissibleReason } from "@/lib/updateRequired";

/**
 * Global non-dismissible dialog that asks the user to reload after a critical
 * server/protocol/PWA update. Mounted once at the app shell level — see
 * src/App.jsx — and driven entirely by the `hush:update-required` event.
 *
 * The dialog has no Cancel button by design: this is the exact case where
 * letting the user "ignore" it could break MLS state. The only way out is
 * the Update action, which either activates a waiting Service Worker or
 * falls back to a plain reload. It never clears auth, vault, MLS, IndexedDB,
 * localStorage, or Cache API state.
 *
 * The copy is intentionally generic so a non-technical user understands the
 * action without needing to know about MLS or PWAs. Rituals fork: a newer
 * build offered because part of this one failed to load is not a critical
 * update (src/lib/chunkRecovery.ts). It says what Update does and may be put
 * off with Later or Escape; a later failure offers it again.
 */
const COPY = {
  critical: {
    title: "Update required",
    description: "A critical update is required to continue syncing securely.",
  },
  newerBuild: {
    title: "Update ready",
    description: "A newer version of this space is ready. Updating reloads this space and any other open Space tabs.",
  },
} as const;

export function UpdateRequiredDialog() {
  const { open, reason, dismiss } = useUpdateRequired();
  const dismissible = isDismissibleReason(reason);
  const copy = dismissible ? COPY.newerBuild : COPY.critical;
  const [busy, setBusy] = useState(false);
  const focusBeforeOpen = useRef<HTMLElement | null>(null);

  function onOpenChange(next: boolean) {
    if (!next && !busy) dismiss();
  }

  // Rituals fork: no click opens this dialog, and it can open while the person
  // is typing. Focus goes to the dialog itself, not a button: a screen reader
  // still announces it and Tab reaches the buttons, but the next keystroke
  // presses nothing. Update reloads the page, so this holds for a critical
  // update too. Closing gives the focus back.
  function onOpenAutoFocus(event: Event) {
    event.preventDefault();
    const active = document.activeElement;
    focusBeforeOpen.current = active instanceof HTMLElement ? active : null;
    (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function onCloseAutoFocus(event: Event) {
    event.preventDefault();
    const element = focusBeforeOpen.current;
    focusBeforeOpen.current = null;
    if (element?.isConnected) element.focus({ preventScroll: true });
  }

  async function onUpdateClick() {
    if (busy) return;
    setBusy(true);
    try {
      await applyUpdate();
    } catch {
      // applyUpdate already swallows its internal errors and triggers
      // reload(). If we land here the reload itself failed; clear the
      // busy flag so the button is at least retry-able.
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        // Block the close-on-overlay-click and Escape paths so the dialog
        // truly cannot be dismissed without resolving the update. The cast
        // is because radix-ui's `AlertDialogContent` types `onEscapeKeyDown`
        // / `onInteractOutside` on the underlying primitive but they are
        // forwarded through the spread in our wrapper. Rituals fork: Escape
        // puts off an offer that may wait (Later does the same).
        {...({
          onEscapeKeyDown: (e: Event) => {
            if (!dismissible || busy) e.preventDefault();
          },
          onPointerDownOutside: (e: Event) => e.preventDefault(),
          onInteractOutside: (e: Event) => e.preventDefault(),
        } as Record<string, (e: Event) => void>)}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        data-testid="update-required-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {dismissible ? (
            <AlertDialogCancel disabled={busy} data-testid="update-required-later">
              Later
            </AlertDialogCancel>
          ) : null}
          <Button
            type="button"
            disabled={busy}
            onClick={onUpdateClick}
            data-testid="update-required-action"
          >
            {busy ? "Updating…" : "Update"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default UpdateRequiredDialog;
