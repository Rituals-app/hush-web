import { useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useUpdateRequired } from "@/hooks/useUpdateRequired";
import { applyUpdate } from "@/lib/updateRequired";

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
 * update, so it says what Update does instead (src/lib/chunkRecovery.ts).
 */
const COPY = {
  critical: {
    title: "Update required",
    description: "A critical update is required to continue syncing securely.",
  },
  newerBuild: {
    title: "Update needed",
    description: "A newer version of this space is ready. Updating reloads this space and any other open Space tabs.",
  },
} as const;

export function UpdateRequiredDialog() {
  const { open, reason } = useUpdateRequired();
  const copy = reason === "chunk-load-failed" ? COPY.newerBuild : COPY.critical;
  const [busy, setBusy] = useState(false);

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
    <AlertDialog open={open}>
      <AlertDialogContent
        // Block the close-on-overlay-click and Escape paths so the dialog
        // truly cannot be dismissed without resolving the update. The cast
        // is because radix-ui's `AlertDialogContent` types `onEscapeKeyDown`
        // / `onInteractOutside` on the underlying primitive but they are
        // forwarded through the spread in our wrapper.
        {...({
          onEscapeKeyDown: (e: Event) => e.preventDefault(),
          onPointerDownOutside: (e: Event) => e.preventDefault(),
          onInteractOutside: (e: Event) => e.preventDefault(),
        } as Record<string, (e: Event) => void>)}
        data-testid="update-required-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
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
