import * as React from "react"
import { useNavigate } from "react-router-dom"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  Link2Icon,
  LogInIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button.tsx"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator.tsx"
import { cn } from "@/lib/utils.ts"

import { RitualsMark } from "@/components/brand/HushLogo"
import {
  RITUALS_HOME_URL,
  SPACE_SOURCE_LINKS,
  isEmbedded,
} from "@/lib/ritualsSpace"
import { BODY_SCROLL_MODE, useBodyScrollMode } from "@/hooks/useBodyScrollMode"
import { generateIdentityMnemonic } from "@/lib/bip39Identity"
import { checkUsernameAvailable } from "@/lib/api"

type AuthView = "main" | "sign-in" | "link" | "sign-up"

interface InstanceProps {
  instances: string[]
  active: string
  onSelect: (value: string) => void
  onAdd: (value: string) => void
}

interface SignUpPayload {
  username: string
  displayName: string
  mnemonic: string
}

interface AuthFlowProps {
  instanceProps: InstanceProps
  /** Full URL of the active instance (used for backend reachability checks). */
  instanceUrl: string
  signIn: (mnemonic: string) => Promise<void> | void
  signUp: (payload: SignUpPayload) => Promise<void> | void
  onOpenRoadmap?: () => void
  /**
   * When the user reached this flow via "Not you? Sign in" on PIN unlock,
   * the shell forwards a callback that returns them to the PIN unlock
   * panel without losing the existing session. Absent when the flow was
   * entered fresh (no prior session to return to).
   */
  onBackToPin?: () => void
  versionLabel?: string
}

export function AuthFlow({
  instanceProps,
  instanceUrl,
  signIn,
  signUp,
  onOpenRoadmap,
  onBackToPin,
  versionLabel = "v0.7.0-alpha.6",
}: AuthFlowProps) {
  const [view, setView] = React.useState<AuthView>("main")
  useBodyScrollMode(BODY_SCROLL_MODE.SCROLL)

  return (
    <div className="flex min-h-svh w-full flex-col bg-background px-4 py-4 sm:px-6">
      {/* `my-auto` centers when content fits the viewport; collapses to
          regular block flow (top-anchored, scrollable) when content is
          taller than the viewport. Works on every screen size without a
          breakpoint switch. */}
      <div className="my-auto flex w-full max-w-md flex-col items-center gap-6 self-center sm:gap-8">
        <RitualsMark className="h-10 w-10" />
        <h1 className="text-2xl font-semibold tracking-tight">
          {titleFor(view)}
        </h1>
        <Card className="w-full p-6">
          {view === "main" ? (
            <MainPanel
              onSignIn={() => setView("sign-in")}
              onLink={() => setView("link")}
              onSignUp={() => setView("sign-up")}
              onBackToPin={onBackToPin}
              onOpenRoadmap={onOpenRoadmap}
              instanceProps={instanceProps}
              versionLabel={versionLabel}
            />
          ) : view === "sign-in" ? (
            <SignInPanel
              onBack={() => setView("main")}
              onContinue={signIn}
              onOpenRoadmap={onOpenRoadmap}
              instanceProps={instanceProps}
              versionLabel={versionLabel}
            />
          ) : view === "link" ? (
            <LinkDevicePanel
              onBack={() => setView("main")}
              onOpenRoadmap={onOpenRoadmap}
              instanceProps={instanceProps}
              versionLabel={versionLabel}
            />
          ) : (
            <SignUpPanel
              onBack={() => setView("main")}
              onComplete={signUp}
              onOpenRoadmap={onOpenRoadmap}
              instanceProps={instanceProps}
              instanceUrl={instanceUrl}
              versionLabel={versionLabel}
            />
          )}
        </Card>
      </div>
    </div>
  )
}

/**
 * Clipboard write with a legacy fallback. `navigator.clipboard.writeText` only
 * works on secure contexts (HTTPS / localhost). Mobile devices hitting the dev
 * server over a LAN IP (http://192.168.x.x:5173/) hit an insecure context and
 * the API is undefined or rejects with NotAllowedError, which silently broke
 * the recovery-phrase Copy button. Fall back to a hidden `<textarea>` +
 * `document.execCommand('copy')` so the affordance keeps working off-HTTPS.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function titleFor(view: AuthView): string {
  switch (view) {
    case "main":
      return "Rituals Space"
    case "sign-in":
    case "link":
      return "Log in to your spaces"
    case "sign-up":
      return "Welcome to Rituals Space"
  }
}

/**
 * Rituals fork: the upstream footer carried an instance picker, a
 * "self-hostable" line with the upstream repository and a roadmap link.
 * Spaces always talk to this origin, so all that is left is the AGPL source
 * link and the version.
 */
function PanelFooter({
  versionLabel,
}: {
  instanceProps?: InstanceProps
  onOpenRoadmap?: () => void
  versionLabel: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <Separator />
      <p className="text-center text-xs text-muted-foreground">
        <a
          className="font-medium underline-offset-4 hover:underline"
          href={SPACE_SOURCE_LINKS.index}
          target="_blank"
          rel="noreferrer noopener"
        >
          Source
        </a>
        <span aria-hidden className="px-1.5">·</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {versionLabel}
        </span>
      </p>
    </div>
  )
}

function MainPanel({
  onSignIn,
  onLink,
  onSignUp,
  onBackToPin,
  onOpenRoadmap,
  instanceProps,
  versionLabel,
}: {
  onSignIn: () => void
  onLink: () => void
  onSignUp: () => void
  onBackToPin?: () => void
  onOpenRoadmap?: () => void
  instanceProps: InstanceProps
  versionLabel: string
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-center text-sm text-muted-foreground">
        Spaces open from a shared task in Rituals. If you already use spaces
        on another device, log in with your recovery phrase or link this
        device.
      </p>
      <Button size="lg" className="h-12 w-full" onClick={onSignIn}>
        <LogInIcon />
        Log in with recovery phrase
      </Button>
      <Button
        size="lg"
        variant="secondary"
        className="h-12 w-full"
        onClick={onLink}
      >
        <Link2Icon />
        Link to existing device
      </Button>
      {/* Rituals fork: no "Sign up" here. A new identity is created on its
          own when someone opens a space from Rituals (the signed ticket is
          its invitation); this server takes no other registrations. */}
      {isEmbedded() ? null : (
        <p className="text-center text-sm text-muted-foreground">
          New here?{" "}
          <a
            href={RITUALS_HOME_URL}
            className="font-semibold text-foreground underline-offset-4 hover:underline"
          >
            Open Rituals
          </a>{" "}
          and tap the people on a shared task.
        </p>
      )}
      {onBackToPin ? (
        // Surfaced only when the user landed here by clicking "Not you?
        // Sign in" on the PIN unlock panel. Lets them step back to PIN
        // entry without abandoning the existing session — important
        // because every other route from this view destroys vault state.
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={onBackToPin}
        >
          <ArrowLeftIcon />
          Back to PIN
        </Button>
      ) : null}
      <PanelFooter
        instanceProps={instanceProps}
        onOpenRoadmap={onOpenRoadmap}
        versionLabel={versionLabel}
      />
    </div>
  )
}

function SignInPanel({
  onBack,
  onContinue,
  onOpenRoadmap,
  instanceProps,
  versionLabel,
}: {
  onBack: () => void
  onContinue: (mnemonic: string) => Promise<void> | void
  onOpenRoadmap?: () => void
  instanceProps: InstanceProps
  versionLabel: string
}) {
  const [words, setWords] = React.useState<string[]>(() =>
    Array.from({ length: 12 }, () => "")
  )
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const filled = words.filter((w) => w.trim().length > 0).length
  const valid = filled === 12

  const handleSubmit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const mnemonic = words.map((w) => w.trim().toLowerCase()).join(" ")
      await onContinue(mnemonic)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Recovery phrase</h2>
        <p className="text-sm text-muted-foreground">
          Enter the 12 words from when you signed up. Paste them all at once to
          auto-fill.
        </p>
      </div>
      <SeedPhraseGrid words={words} onChange={setWords} />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{filled} / 12 words</span>
        <span className={cn(valid && "text-success font-medium")}>
          {valid ? "Looks good" : "Fill all 12 cells"}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Separator />
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          <ArrowLeftIcon />
          Back
        </Button>
        <Button onClick={handleSubmit} disabled={!valid || submitting}>
          <ArrowRightIcon />
          {submitting ? "Signing in…" : "Continue"}
        </Button>
      </div>
      <PanelFooter
        instanceProps={instanceProps}
        onOpenRoadmap={onOpenRoadmap}
        versionLabel={versionLabel}
      />
    </div>
  )
}

function SeedPhraseGrid({
  words,
  onChange,
}: {
  words: string[]
  onChange: (next: string[]) => void
}) {
  const inputsRef = React.useRef<Array<HTMLInputElement | null>>([])

  const handleChange = (index: number, value: string) => {
    const next = [...words]
    next[index] = value
    onChange(next)
  }

  const handlePaste = (
    index: number,
    event: React.ClipboardEvent<HTMLInputElement>
  ) => {
    const text = event.clipboardData.getData("text")
    if (!text) return
    const tokens = text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase())
    if (tokens.length < 2) return
    event.preventDefault()
    const next = [...words]
    for (let i = 0; i < tokens.length && index + i < next.length; i++) {
      next[index + i] = tokens[i]
    }
    onChange(next)
    const focusIndex = Math.min(index + tokens.length, next.length - 1)
    requestAnimationFrame(() => {
      inputsRef.current[focusIndex]?.focus()
    })
  }

  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === " " || event.key === "Tab") {
      if (words[index].trim() && index < words.length - 1) {
        event.preventDefault()
        inputsRef.current[index + 1]?.focus()
      }
    } else if (event.key === "Backspace" && !words[index] && index > 0) {
      event.preventDefault()
      inputsRef.current[index - 1]?.focus()
    }
  }

  return (
    <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/20 p-3">
      {words.map((word, idx) => (
        <div
          key={idx}
          className="flex items-center gap-1.5 rounded-sm border bg-background pl-2 focus-within:ring-2 focus-within:ring-ring/40"
        >
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {String(idx + 1).padStart(2, "0")}
          </span>
          <input
            ref={(el) => {
              inputsRef.current[idx] = el
            }}
            value={word}
            onChange={(event) => handleChange(idx, event.target.value)}
            onPaste={(event) => handlePaste(idx, event)}
            onKeyDown={(event) => handleKeyDown(idx, event)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
            aria-label={`Word ${idx + 1}`}
          />
        </div>
      ))}
    </div>
  )
}

function LinkDevicePanel({
  onBack,
  onOpenRoadmap,
  instanceProps,
  versionLabel,
}: {
  onBack: () => void
  onOpenRoadmap?: () => void
  instanceProps: InstanceProps
  versionLabel: string
}) {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Link this device</h2>
        <p className="text-sm text-muted-foreground">
          Use your spaces on this device by scanning a QR code or entering
          a one-time code from a device you are already signed in on.
        </p>
      </div>

      <Button size="lg" onClick={() => navigate("/link-device?mode=new")}>
        <Link2Icon />
        Continue to device linking
      </Button>

      <Separator />

      <Button variant="ghost" onClick={onBack}>
        <ArrowLeftIcon />
        Back
      </Button>

      <PanelFooter
        instanceProps={instanceProps}
        onOpenRoadmap={onOpenRoadmap}
        versionLabel={versionLabel}
      />
    </div>
  )
}

function SignUpPanel({
  onBack,
  onComplete,
  onOpenRoadmap,
  instanceProps,
  instanceUrl,
  versionLabel,
}: {
  onBack: () => void
  onComplete: (payload: SignUpPayload) => Promise<void> | void
  onOpenRoadmap?: () => void
  instanceProps: InstanceProps
  instanceUrl: string
  versionLabel: string
}) {
  const [step, setStep] = React.useState(0)
  const [username, setUsername] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [usernameAvailable, setUsernameAvailable] = React.useState<boolean | null>(null)
  const [usernameChecking, setUsernameChecking] = React.useState(false)
  const [confirmValid, setConfirmValid] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [mnemonic, setMnemonic] = React.useState<string>(() => generateIdentityMnemonic())
  const mnemonicWords = React.useMemo(() => mnemonic.split(" "), [mnemonic])

  const [passphraseSaved, setPassphraseSaved] = React.useState(false)
  const startOver = () => {
    setMnemonic(generateIdentityMnemonic())
    setConfirmValid(false)
    setPassphraseSaved(false)
    setStep(0)
  }
  // 3 wizard steps: username, recovery phrase reveal, confirm. PIN setup is
  // a separate post-register UI driven by bootController.
  const totalSteps = 3

  const next = async () => {
    if (step < totalSteps - 1) {
      setStep((s) => s + 1)
      return
    }
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onComplete({
        username: username.trim(),
        displayName: displayName.trim(),
        mnemonic,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-up failed")
    } finally {
      setSubmitting(false)
    }
  }

  const prev = () => {
    if (submitting) return
    if (step === 0) {
      onBack()
    } else {
      setStep((s) => s - 1)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-center gap-1.5">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "size-1.5 rounded-full transition-colors",
              i === step ? "bg-foreground" : "bg-muted"
            )}
          />
        ))}
      </div>

      {step === 0 ? (
        <UsernameStep
          username={username}
          displayName={displayName}
          onUsername={setUsername}
          onDisplayName={setDisplayName}
          instanceUrl={instanceUrl}
          available={usernameAvailable}
          onAvailableChange={setUsernameAvailable}
          checking={usernameChecking}
          onCheckingChange={setUsernameChecking}
        />
      ) : step === 1 ? (
        <PassphraseStep
          words={mnemonicWords}
          confirmedSaved={passphraseSaved}
          onConfirmedSavedChange={setPassphraseSaved}
        />
      ) : (
        <ConfirmStep
          words={mnemonicWords}
          onValidChange={setConfirmValid}
        />
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <Separator />

      <div className="flex items-center justify-between gap-3">
        {step === totalSteps - 1 ? (
          <Button
            variant="ghost"
            onClick={startOver}
            disabled={submitting}
          >
            <RefreshCwIcon />
            Start over
          </Button>
        ) : (
          <Button variant="ghost" onClick={prev} disabled={submitting}>
            <ArrowLeftIcon />
            Back
          </Button>
        )}
        <Button
          onClick={next}
          disabled={
            submitting ||
            (step === 0 &&
              (!username.trim() || usernameChecking || usernameAvailable !== true)) ||
            (step === 1 && !passphraseSaved) ||
            (step === totalSteps - 1 && !confirmValid)
          }
        >
          {step === totalSteps - 1 ? (
            <>
              <CheckIcon />
              {submitting ? "Creating…" : "Finish"}
            </>
          ) : (
            <>
              <ArrowRightIcon />
              Continue
            </>
          )}
        </Button>
      </div>

      <PanelFooter
        instanceProps={instanceProps}
        onOpenRoadmap={onOpenRoadmap}
        versionLabel={versionLabel}
      />
    </div>
  )
}

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/

function UsernameStep({
  username,
  displayName,
  onUsername,
  onDisplayName,
  instanceUrl,
  available,
  onAvailableChange,
  checking,
  onCheckingChange,
}: {
  username: string
  displayName: string
  onUsername: (value: string) => void
  onDisplayName: (value: string) => void
  instanceUrl: string
  available: boolean | null
  onAvailableChange: (value: boolean | null) => void
  checking: boolean
  onCheckingChange: (value: boolean) => void
}) {
  const trimmed = username.trim().toLowerCase()
  const isValidShape = USERNAME_RE.test(trimmed)

  // Debounced availability check.
  React.useEffect(() => {
    if (!isValidShape) {
      onAvailableChange(null)
      onCheckingChange(false)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    onCheckingChange(true)
    const id = window.setTimeout(async () => {
      try {
        const ok = await checkUsernameAvailable(trimmed, instanceUrl, controller.signal)
        if (!cancelled) onAvailableChange(Boolean(ok))
      } catch {
        if (!cancelled) onAvailableChange(null)
      } finally {
        if (!cancelled) onCheckingChange(false)
      }
    }, 400)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(id)
      onCheckingChange(false)
    }
  }, [trimmed, isValidShape, instanceUrl, onAvailableChange, onCheckingChange])

  let feedback: React.ReactNode = null
  if (!username) {
    feedback = null
  } else if (!isValidShape) {
    feedback = (
      <span className="text-xs text-muted-foreground">
        3–32 chars: lowercase letters, digits, dashes, underscores
      </span>
    )
  } else if (checking) {
    feedback = <span className="text-xs text-muted-foreground">Checking…</span>
  } else if (available === true) {
    feedback = (
      <span className="text-xs text-success font-medium">
        {trimmed} is available
      </span>
    )
  } else if (available === false) {
    feedback = (
      <span className="text-xs text-destructive font-medium">
        {trimmed} is already taken
      </span>
    )
  } else {
    feedback = (
      <span className="text-xs text-muted-foreground">
        Could not reach instance — check connection
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Choose a username</h2>
        <p className="text-sm text-muted-foreground">
          Your username is your identity on this server.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="signup-username">Username</Label>
        <Input
          id="signup-username"
          value={username}
          onChange={(event) => onUsername(event.target.value)}
          placeholder="e.g. alice"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={available === false || (Boolean(username) && !isValidShape)}
        />
        {feedback}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="signup-display">
          Display name{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="signup-display"
          value={displayName}
          onChange={(event) => onDisplayName(event.target.value)}
          placeholder="How others see you"
        />
      </div>
    </div>
  )
}

function PassphraseStep({
  words,
  confirmedSaved,
  onConfirmedSavedChange,
}: {
  words: string[]
  confirmedSaved: boolean
  onConfirmedSavedChange: (next: boolean) => void
}) {
  const [copied, setCopied] = React.useState(false)
  const checkboxId = React.useId()

  const handleCopy = async () => {
    if (await copyToClipboard(words.join(" "))) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Save your recovery phrase</h2>
        <p className="text-sm text-muted-foreground">
          Write these 12 words down and keep them safe. They are the only way to
          recover your account.
        </p>
      </div>
      <div className="overflow-hidden rounded-md border bg-muted/30">
        <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            12-word recovery phrase
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Copy phrase"
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
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
          {words.map((word, idx) => (
            <div
              key={`${word}-${idx}`}
              className="flex items-center gap-2 rounded-sm bg-background px-2 py-1.5 text-sm"
            >
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span className="truncate font-mono">{word}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Gate the next-step transition behind an explicit user
          confirmation. Losing the phrase = losing the account, so a
          deliberate checkbox click is cheap insurance against
          accidental "Continue" presses. */}
      <label
        htmlFor={checkboxId}
        className="flex cursor-pointer items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm"
      >
        <Checkbox
          id={checkboxId}
          checked={confirmedSaved}
          onCheckedChange={(value) => onConfirmedSavedChange(value === true)}
          className="mt-0.5"
        />
        <span className="text-foreground">
          I have saved my recovery phrase. I understand I cannot recover my
          account without it.
        </span>
      </label>
    </div>
  )
}

function pickRandomPositions(max: number, count: number): number[] {
  const pool = Array.from({ length: max }, (_, i) => i)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count).sort((a, b) => a - b)
}

/**
 * Confirms the user has saved the recovery phrase by asking for 3 random
 * positions instead of all 12 words. Mirrors hush-web's MnemonicConfirm
 * pattern; mockup originally re-typed all 12.
 */
function ConfirmStep({
  words,
  onValidChange,
}: {
  words: string[]
  onValidChange: (valid: boolean) => void
}) {
  const [positions] = React.useState<number[]>(() =>
    pickRandomPositions(words.length, 3)
  )
  const [inputs, setInputs] = React.useState<string[]>(["", "", ""])

  const fieldState = React.useCallback(
    (i: number): "idle" | "correct" | "wrong" => {
      const value = inputs[i]?.trim()
      if (!value) return "idle"
      const expected = words[positions[i]]?.toLowerCase()
      return value.toLowerCase() === expected ? "correct" : "wrong"
    },
    [inputs, positions, words]
  )

  const allCorrect = inputs.every((_, i) => fieldState(i) === "correct")

  React.useEffect(() => {
    onValidChange(allCorrect)
  }, [allCorrect, onValidChange])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Verify your phrase</h2>
        <p className="text-sm text-muted-foreground">
          Enter the requested words to confirm you saved your recovery phrase.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {positions.map((wordIndex, i) => {
          const state = fieldState(i)
          return (
            <div key={wordIndex} className="flex flex-col gap-2">
              <Label htmlFor={`confirm-word-${i}`}>
                Word #{wordIndex + 1}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`confirm-word-${i}`}
                  type="text"
                  value={inputs[i]}
                  onChange={(event) => {
                    const next = [...inputs]
                    next[i] = event.target.value
                    setInputs(next)
                  }}
                  placeholder="Type the word…"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  aria-invalid={state === "wrong"}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "w-4 text-center text-sm font-medium",
                    state === "correct" && "text-success",
                    state === "wrong" && "text-destructive",
                    state === "idle" && "invisible"
                  )}
                >
                  {state === "correct" ? "✓" : state === "wrong" ? "✗" : ""}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
