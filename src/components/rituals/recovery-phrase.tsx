/**
 * "Save recovery phrase" (Rituals fork, 2026-11-05).
 *
 * A space entry creates this device's identity with no input, so the 12
 * words were never shown. They are kept sealed on this device
 * (src/lib/ritualsRecoveryPhrase.ts) while `rituals_space_phrase_unsaved=1`.
 * Settings › Recovery phrase reveals them with a copy button; confirming
 * deletes the kept copy and clears the flag. While the flag is set, a small
 * reminder sits above the account menu in the channel sidebar.
 */
import * as React from "react"
import { CheckIcon, CopyIcon, KeyRoundIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/contexts/AuthContext"
import {
  deleteRecoveryPhrase,
  readRecoveryPhrase,
} from "@/lib/ritualsRecoveryPhrase"
import {
  PHRASE_UNSAVED_KEY,
  isRecoveryPhraseUnsaved,
  setRecoveryPhraseUnsaved,
} from "@/lib/ritualsSpace"

const SNOOZE_KEY = "rituals_space_phrase_reminder_snoozed"

/** True while the person has not saved the phrase of this device's identity. */
export function useRecoveryPhraseUnsaved(): boolean {
  const [unsaved, setUnsaved] = React.useState(() => isRecoveryPhraseUnsaved())
  React.useEffect(() => {
    const sync = () => setUnsaved(isRecoveryPhraseUnsaved())
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PHRASE_UNSAVED_KEY) sync()
    }
    window.addEventListener("rituals:phrase-unsaved", sync)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener("rituals:phrase-unsaved", sync)
      window.removeEventListener("storage", onStorage)
    }
  }, [])
  return unsaved
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Gentle reminder above the account menu. "Later" hides it for this tab;
 * it comes back next time until the phrase is saved.
 */
export function RecoveryPhraseReminder({ onSave }: { onSave?: () => void }) {
  const unsaved = useRecoveryPhraseUnsaved()
  const [snoozed, setSnoozed] = React.useState(() => {
    try {
      return sessionStorage.getItem(SNOOZE_KEY) === "1"
    } catch {
      return false
    }
  })
  if (!unsaved || snoozed || !onSave) return null

  const snooze = () => {
    setSnoozed(true)
    try {
      sessionStorage.setItem(SNOOZE_KEY, "1")
    } catch {
      // ignore
    }
  }

  return (
    <div
      role="note"
      className="relative flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 text-xs"
    >
      <button
        type="button"
        onClick={snooze}
        aria-label="Remind me later"
        className="absolute top-1.5 right-1.5 rounded-sm p-1 text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
      <div className="flex items-start gap-2 pr-5">
        <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">Save your recovery phrase</span>{" "}
          to get back into your spaces on a new device.
        </p>
      </div>
      <div className="flex gap-2 pl-5.5">
        <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={onSave}>
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-xs"
          onClick={snooze}
        >
          Later
        </Button>
      </div>
    </div>
  )
}

type PanelState = "loading" | "kept" | "saved" | "none"

/** Settings › Recovery phrase. */
export function RecoveryPhrasePanel() {
  const { user } = useAuth() as { user: { id?: string } | null }
  const userId = user?.id ?? ""
  const [state, setState] = React.useState<PanelState>("loading")
  const [phrase, setPhrase] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [confirmed, setConfirmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const checkboxId = React.useId()

  React.useEffect(() => {
    let cancelled = false
    setState("loading")
    setRevealed(false)
    setConfirmed(false)
    readRecoveryPhrase(userId)
      .then((kept) => {
        if (cancelled) return
        setPhrase(kept)
        setState(kept ? "kept" : "none")
        // Nothing kept to save: the reminder has nothing to offer.
        if (!kept && isRecoveryPhraseUnsaved()) setRecoveryPhraseUnsaved(false)
      })
      .catch(() => {
        if (!cancelled) setState("none")
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const words = React.useMemo(() => (phrase ? phrase.split(/\s+/) : []), [phrase])

  const handleCopy = async () => {
    if (!phrase) return
    if (await copyText(phrase)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  const handleSaved = async () => {
    if (!userId) return
    setBusy(true)
    try {
      await deleteRecoveryPhrase(userId)
      setRecoveryPhraseUnsaved(false)
      setPhrase(null)
      setRevealed(false)
      setState("saved")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Recovery phrase</h2>
        <p className="text-sm text-muted-foreground">
          Your spaces identity lives on this device. These 12 words are the
          only way back into your spaces if this device is lost or its data
          is cleared.
        </p>
      </div>

      <Separator />

      {state === "loading" ? (
        <p className="text-sm text-muted-foreground">Checking this device…</p>
      ) : state === "saved" ? (
        <div className="rounded-lg border bg-card p-4 text-sm">
          <p className="font-medium">Saved.</p>
          <p className="mt-1 text-muted-foreground">
            This device no longer keeps a copy. Keep your words somewhere
            safe.
          </p>
        </div>
      ) : state === "none" ? (
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          This device doesn&apos;t keep your recovery phrase. If you saved it
          earlier, keep it somewhere safe. To use your spaces on another
          device, link it from Devices.
        </div>
      ) : !revealed ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            Write the words down or keep them in a password manager. Anyone
            with them can open your spaces as you, so show them only where no
            one else can see your screen.
          </p>
          <Button type="button" onClick={() => setRevealed(true)}>
            Show recovery phrase
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-md border bg-muted/30">
            <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                12-word recovery phrase
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Copy recovery phrase"
              >
                {copied ? (
                  <>
                    <CheckIcon className="size-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <CopyIcon className="size-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <ol className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
              {words.map((word, idx) => (
                <li
                  key={`${idx}-${word}`}
                  className="flex items-center gap-2 rounded-sm bg-background px-2 py-1.5 text-sm"
                >
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <span className="truncate font-mono">{word}</span>
                </li>
              ))}
            </ol>
          </div>
          <label
            htmlFor={checkboxId}
            className="flex cursor-pointer items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm"
          >
            <Checkbox
              id={checkboxId}
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
              className="mt-0.5"
            />
            <span>I saved these 12 words somewhere safe.</span>
          </label>
          <div className="flex gap-2">
            <Button type="button" onClick={handleSaved} disabled={!confirmed || busy}>
              {busy ? "Saving…" : "Done"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRevealed(false)}>
              Hide
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
