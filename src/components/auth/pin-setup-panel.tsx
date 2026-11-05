/**
 * PIN setup panel — re-skin of hush-web's PinSetupModal.
 *
 * Behavioural contract is preserved 1:1:
 *  - Tabs to switch between PIN (numeric) and passphrase (text) mode
 *  - PIN: type=password + inputMode=numeric (mobile numeric keypad), min 4
 *  - Passphrase: type=password + min 6 + live strength bar / label
 *  - Confirm field with inline mismatch error
 *  - Skip-for-now ghost button + Set PIN/Passphrase primary button
 *  - Skip warning footer copy
 *
 * Wires to `useAuth().setPIN(pin)` + `useAuth().skipPinSetup()`.
 */
import * as React from "react"
import { CheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button.tsx"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.tsx"
import { cn } from "@/lib/utils.ts"
import { HushLogo } from "@/components/brand/HushLogo"
import { PIN_LENGTH } from "@/components/auth/pin-otp"
import { PinOtpSetup } from "@/components/auth/pin-otp-setup"
import { useAuth } from "@/contexts/AuthContext"
import { useIsMobile } from "@/hooks/use-mobile"

const STRENGTH_LABELS = ["", "Weak", "Fair", "Good", "Strong"] as const

function passphraseStrength(value: string): number {
  if (value.length < 6) return 0
  if (value.length < 9) return 1
  if (value.length < 12) return 2
  if (value.length < 16) return 3
  return 4
}

function strengthBarClass(level: number): string {
  if (level < 2) return "bg-destructive"
  if (level < 3) return "bg-amber-500"
  return "bg-success"
}

function strengthLabelClass(level: number): string {
  if (level < 2) return "text-destructive"
  if (level < 3) return "text-amber-500"
  return "text-success"
}

export function PinSetupPanel() {
  const { setPIN, skipPinSetup } = useAuth() as {
    setPIN: (pin: string) => Promise<void>
    skipPinSetup: () => void
  }
  const [mode, setMode] = React.useState<"pin" | "passphrase">("pin")
  const [value, setValue] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const isPin = mode === "pin"
  // Segmented OTP cells are only used on mobile so the digit-by-digit
  // tap flow lines up with the soft keypad. On desktop a normal masked
  // input feels more natural for keyboard entry, especially when the
  // user pastes a saved PIN from a password manager.
  const isMobileViewport = useIsMobile()
  // PIN is fixed at PIN_LENGTH (4) digits. Passphrase keeps the previous
  // 6-char minimum since it's free-form.
  const minLength = isPin ? PIN_LENGTH : 6
  const strength = !isPin ? passphraseStrength(value) : 0
  const valueOk = isPin ? value.length === PIN_LENGTH : value.length >= minLength
  const confirmOk = value === confirm && valueOk
  const mismatch = confirm.length > 0 && value !== confirm

  const switchMode = (next: string) => {
    setMode(next as "pin" | "passphrase")
    setValue("")
    setConfirm("")
    setError(null)
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!confirmOk || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await setPIN(value)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to set ${isPin ? "PIN" : "passphrase"}.`
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <HushLogo className="h-10 w-10" />
        <h1 className="text-2xl font-semibold tracking-tight">Lock your vault</h1>
        <Card className="w-full p-6">
          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            <p className="text-sm text-muted-foreground">
              Your {isPin ? "PIN" : "passphrase"} encrypts your identity key on
              this device. You will need it to unlock your spaces after
              closing your browser.
            </p>

            <Tabs value={mode} onValueChange={switchMode}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="pin">Use a PIN</TabsTrigger>
                <TabsTrigger value="passphrase">Use a passphrase</TabsTrigger>
              </TabsList>

              <TabsContent value="pin" className="flex flex-col items-center gap-2 pt-3">
                <Label htmlFor="psm-pin-value">PIN ({PIN_LENGTH} digits)</Label>
                {isMobileViewport ? (
                  <PinOtpSetup
                    id="psm-pin-value"
                    value={value}
                    onChange={setValue}
                    disabled={submitting}
                    ariaLabel="Choose PIN"
                    autoFocus
                  />
                ) : (
                  <Input
                    id="psm-pin-value"
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={PIN_LENGTH}
                    value={value}
                    onChange={(e) =>
                      setValue(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder={`Enter ${PIN_LENGTH} digits`}
                    autoComplete="new-password"
                    disabled={submitting}
                    aria-label="Choose PIN"
                    autoFocus
                    className="w-full text-center tracking-[0.5em] placeholder:tracking-normal"
                  />
                )}
              </TabsContent>

              <TabsContent
                value="passphrase"
                className="flex flex-col gap-2 pt-3"
              >
                <Label htmlFor="psm-phrase-value">
                  Passphrase (min 6 characters)
                </Label>
                <Input
                  id="psm-phrase-value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Enter a passphrase"
                  minLength={6}
                  autoComplete="new-password"
                  disabled={submitting}
                />
                {value.length >= 2 ? (
                  <div className="flex items-center gap-2 pt-1">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full transition-all duration-200",
                          strengthBarClass(strength)
                        )}
                        style={{ width: `${(strength / 4) * 100}%` }}
                      />
                    </div>
                    {strength > 0 ? (
                      <span
                        className={cn(
                          "w-12 text-right text-[10px] font-medium uppercase tracking-wide",
                          strengthLabelClass(strength)
                        )}
                      >
                        {STRENGTH_LABELS[strength]}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </TabsContent>
            </Tabs>

            <div className={cn("flex flex-col gap-2", isPin && "items-center")}>
              <Label htmlFor="pin-setup-confirm">
                Confirm {isPin ? "PIN" : "passphrase"}
              </Label>
              {isPin ? (
                isMobileViewport ? (
                  <PinOtpSetup
                    id="pin-setup-confirm"
                    value={confirm}
                    onChange={setConfirm}
                    disabled={submitting}
                    ariaInvalid={mismatch}
                    ariaLabel="Confirm PIN"
                  />
                ) : (
                  <Input
                    id="pin-setup-confirm"
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={PIN_LENGTH}
                    value={confirm}
                    onChange={(e) =>
                      setConfirm(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder={`Repeat ${PIN_LENGTH} digits`}
                    autoComplete="new-password"
                    disabled={submitting}
                    aria-invalid={mismatch}
                    aria-label="Confirm PIN"
                    className="w-full text-center tracking-[0.5em] placeholder:tracking-normal"
                  />
                )
              ) : (
                <Input
                  id="pin-setup-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat your passphrase"
                  minLength={minLength}
                  autoComplete="new-password"
                  disabled={submitting}
                  aria-invalid={mismatch}
                />
              )}
              {mismatch ? (
                <p role="alert" className="text-xs text-destructive">
                  {isPin ? "PINs do not match" : "Passphrases do not match"}
                </p>
              ) : null}
            </div>

            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={skipPinSetup}
                disabled={submitting}
              >
                Skip for now
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={!confirmOk || submitting}
                className="flex-1"
              >
                <CheckIcon />
                {submitting
                  ? "Saving…"
                  : `Set ${isPin ? "PIN" : "passphrase"}`}
              </Button>
            </div>

            <p className="text-center text-[10px] text-muted-foreground/70">
              Without a {isPin ? "PIN" : "passphrase"}, you would need your
              12-word recovery phrase every time you open your spaces.
            </p>
          </form>
        </Card>
      </div>
    </div>
  )
}
