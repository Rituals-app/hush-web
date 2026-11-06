import { useCallback, useEffect, useState } from "react";

import {
  UPDATE_REQUIRED_EVENT,
  isDismissibleReason,
  type UpdateRequiredDetail,
} from "@/lib/updateRequired";

type Reason = UpdateRequiredDetail["reason"] | null;

interface UpdateRequiredState {
  /** True once any subsystem has raised the Update Required event. */
  open: boolean;
  /**
   * Reason of the event the dialog shows (for copy and telemetry). Kept after a
   * close, because the dialog stays on screen while it animates out.
   */
  reason: Reason;
}

interface UseUpdateRequiredState extends UpdateRequiredState {
  /**
   * Closes the dialog when its reason may be put off (isDismissibleReason);
   * does nothing for a critical one. A later event opens it again.
   */
  dismiss: () => void;
}

const CLOSED: UpdateRequiredState = { open: false, reason: null };

/**
 * Folds a new event into the dialog state. The first event opens it; while it
 * is open, a critical reason replaces one the person may put off (a critical
 * dialog never gives way to a dismissible one), and any other event keeps the
 * stable dialog already shown. A missing reason counts as critical.
 */
export function foldUpdateRequired(prev: UpdateRequiredState, reason: Reason): UpdateRequiredState {
  if (!prev.open) return { open: true, reason };
  if (isDismissibleReason(prev.reason) && !isDismissibleReason(reason)) return { open: true, reason };
  return prev;
}

/**
 * Subscribe to the global `hush:update-required` event.
 *
 * A critical dialog is non-dismissible: once `open` flips true for a critical
 * reason it never flips back. Repeated events are folded (foldUpdateRequired)
 * so the user sees a single stable dialog regardless of how many subsystems
 * flagged the upgrade. Rituals fork: the "chunk-load-failed" offer may be put
 * off with `dismiss`.
 */
export function useUpdateRequired(): UseUpdateRequiredState {
  const [state, setState] = useState<UpdateRequiredState>(CLOSED);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function onUpdate(ev: Event) {
      const detail = (ev as CustomEvent<UpdateRequiredDetail>).detail;
      setState((prev) => foldUpdateRequired(prev, detail?.reason ?? null));
    }

    window.addEventListener(UPDATE_REQUIRED_EVENT, onUpdate);
    return () => window.removeEventListener(UPDATE_REQUIRED_EVENT, onUpdate);
  }, []);

  const dismiss = useCallback(() => {
    setState((prev) => (prev.open && isDismissibleReason(prev.reason) ? { open: false, reason: prev.reason } : prev));
  }, []);

  return { ...state, dismiss };
}
