/**
 * Voice & video preferences panel for the user settings dialog.
 *
 * Behavioural parity with hush-legacy-stable's AudioVideoTab:
 *  - Microphone + camera device pickers (user-scoped, persisted in IDB
 *    via `voiceDevicePrefs` so the prejoin dialog and the active call
 *    pull from the same record).
 *  - Audio-filter card: noise-gate switch + sensitivity threshold slider
 *    (persisted in localStorage via `lib/micProcessing`).
 *  - Mic-test card: local loopback meter driven by `useMicMonitor`.
 *  - Live filter pushdown: while in voice, threshold + gate toggle
 *    changes apply to the published capture graph immediately
 *    (`voiceRuntime.onMicFilterSettingsChange`).
 *  - Mic-test isolation: while in voice, starting the test deafens the
 *    room (or mutes the mic if already deafened) so the local monitor
 *    is the only audible path. Stopping or unmounting (or a failure
 *    during a mid-test mic switch) restores the pre-test state.
 *
 * Permission posture: opening the panel does NOT request mic/camera
 * permission. We only enumerate devices (no labels until permission is
 * granted) and surface explicit "Grant access" buttons. Permission is
 * triggered by user intent — clicking the grant button, or starting
 * the mic test.
 */

import * as React from "react"
import { HeadphonesIcon, MicIcon, VideoIcon } from "lucide-react"

import { isOutputDeviceSelectionSupported } from "@/audio"
import { Button } from "@/components/ui/button.tsx"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator.tsx"
import { useAuth } from "@/contexts/AuthContext"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMicMonitor } from "@/hooks/useMicMonitor"
import {
  mergeVoiceDevicePrefs,
  readVoiceDevicePrefs,
  saveVoiceDevicePrefs,
  subscribeVoiceDevicePrefs,
  type VoiceDevicePrefs,
} from "@/lib/voiceDevicePrefs"

interface RawDevice {
  deviceId: string
  /** Empty string when permission has not been granted yet. */
  rawLabel: string
}

interface MicFilterSettings {
  noiseGateEnabled: boolean
  noiseGateThresholdDb: number
}

export interface VoiceRuntime {
  isInVoice: boolean
  isMuted: boolean
  isDeafened: boolean
  onMute: () => void | Promise<void>
  onDeafen: () => void | Promise<void>
  onMicFilterSettingsChange: (settings: Partial<MicFilterSettings>) => void
  /** Routes the output sink id (HTMLMediaElement.setSinkId) to the
   *  active room's playback manager so peer audio re-routes to the
   *  newly picked output device without leaving and rejoining the
   *  call. No-op when not in voice or when the browser lacks
   *  setSinkId support. */
  onOutputDeviceChange?: (deviceId: string | null) => void | Promise<void>
}

interface VoiceVideoPanelProps {
  voiceRuntime?: VoiceRuntime | null
  prefsScope?: string | null
}

interface IsolationSnapshot {
  appliedDeafen: boolean
  appliedMute: boolean
}

interface DeviceList {
  audio: RawDevice[]
  video: RawDevice[]
  output: RawDevice[]
}

const DEFAULT_OPTION_VALUE = "__default__"
const EMPTY_DEVICE_LIST: DeviceList = { audio: [], video: [], output: [] }

/**
 * Enumerate input devices WITHOUT triggering a permission prompt.
 * Labels remain empty strings until permission has been granted for
 * that kind, which the UI uses to decide whether to show the picker
 * or a "Grant access" button.
 */
async function enumerateDevicesRaw(): Promise<DeviceList> {
  if (!navigator?.mediaDevices?.enumerateDevices) return EMPTY_DEVICE_LIST
  const devices = await navigator.mediaDevices.enumerateDevices()
  const toRaw = (d: MediaDeviceInfo): RawDevice => ({
    deviceId: d.deviceId,
    rawLabel: d.label,
  })
  return {
    audio: devices
      .filter((d) => d.kind === "audioinput" && d.deviceId)
      .map(toRaw),
    video: devices
      .filter((d) => d.kind === "videoinput" && d.deviceId)
      .map(toRaw),
    output: devices
      .filter((d) => d.kind === "audiooutput" && d.deviceId)
      .map(toRaw),
  }
}

async function requestMediaPermission(
  kind: "audio" | "video"
): Promise<void> {
  if (!navigator?.mediaDevices?.getUserMedia) {
    throw new Error("Media capture is not supported on this device.")
  }
  const constraints: MediaStreamConstraints =
    kind === "audio" ? { audio: true } : { video: true }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  stream.getTracks().forEach((track) => track.stop())
}

/**
 * `true` when at least one device of this kind has a non-empty label —
 * which means the browser has surfaced labels for this kind, which only
 * happens after permission has been granted.
 */
function hasPermissionFor(devices: RawDevice[]): boolean {
  return devices.some((d) => d.rawLabel.length > 0)
}

function formatDeviceLabel(
  device: RawDevice,
  fallback: string,
  index: number
): string {
  return device.rawLabel || `${fallback} ${index + 1}`
}

/**
 * Resolve the OS-level default device for a kind so the "Default"
 * option in the picker can read e.g. "Default (MacBook Pro
 * Microphone)" instead of just "Default".
 *
 * Chromium exposes a synthetic `deviceId === 'default'` entry whose
 * label is "Default - <actual device>". Firefox / Safari do not
 * surface such an entry; the first device in enumeration order is
 * the system default. We strip the "Default - " prefix so the
 * displayed string stays clean across browsers.
 *
 * Returns `null` when no labels are populated yet (= permission
 * not granted) so the caller can fall back to a plain "Default".
 */
function resolveDefaultDeviceName(
  devices: RawDevice[]
): string | null {
  if (devices.length === 0) return null
  const synthetic = devices.find((d) => d.deviceId === "default")
  if (synthetic && synthetic.rawLabel) {
    return synthetic.rawLabel.replace(/^Default\s*[-—–:]\s*/i, "")
  }
  // Skip the synthetic entry so the "real" default reflects the
  // first hardware device in the list.
  const firstReal = devices.find(
    (d) => d.deviceId !== "default" && d.deviceId !== "communications"
  )
  if (firstReal && firstReal.rawLabel) return firstReal.rawLabel
  return null
}

function formatDefaultOptionLabel(devices: RawDevice[]): string {
  const name = resolveDefaultDeviceName(devices)
  return name ? `Default (${name})` : "Default"
}

function getMicMonitorErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is required to test your mic."
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone input is available on this device."
  }
  const message = (error as { message?: string })?.message
  return message || "Unable to start mic test."
}

export function VoiceVideoPanel({
  voiceRuntime,
  prefsScope = null,
}: VoiceVideoPanelProps) {
  const { user } = useAuth() as { user: { id?: string } | null }
  const userId = user?.id ?? null
  const isMobile = useIsMobile()
  // Output device selection is desktop-only for now: mobile browsers
  // (and the React Native bridge we'll ship later) own the audio
  // route at the OS level, not via HTMLMediaElement.setSinkId.
  // Disable the picker entirely on mobile and on desktop browsers
  // that lack the API (Firefox/Safari).
  const outputSelectable = !isMobile && isOutputDeviceSelectionSupported()

  // Snapshot of which mute/deafen toggles the panel applied to isolate
  // the mic test, so stopping the test can restore the pre-test state
  // even if voiceRuntime props churn while the test is running.
  const isolationRef = React.useRef<IsolationSnapshot | null>(null)
  // Always read the latest voiceRuntime in async callbacks so we don't
  // capture stale values across the await of `startMicMonitor`.
  const voiceRuntimeRef = React.useRef<VoiceRuntime | null>(
    voiceRuntime ?? null
  )
  React.useEffect(() => {
    voiceRuntimeRef.current = voiceRuntime ?? null
  }, [voiceRuntime])

  const [deviceList, setDeviceList] =
    React.useState<DeviceList>(EMPTY_DEVICE_LIST)
  const [permissionError, setPermissionError] = React.useState<string | null>(
    null
  )
  const [prefs, setPrefs] = React.useState<VoiceDevicePrefs | null>(null)

  const {
    isTesting: isMicTesting,
    error: micTestError,
    setError: setMicTestError,
    levelRef: micLevelRef,
    start: startMicMonitor,
    stop: stopMicMonitor,
  } = useMicMonitor() as {
    isTesting: boolean
    error: Error | null
    setError: (error: Error | null) => void
    levelRef: React.MutableRefObject<number>
    start: (options: {
      deviceId: string | null
      settings: MicFilterSettings
    }) => Promise<void>
    stop: () => Promise<void>
  }

  React.useEffect(() => {
    if (!userId) return
    let cancelled = false
    void readVoiceDevicePrefs(userId, prefsScope).then((stored) => {
      if (!cancelled) setPrefs(stored)
    })
    return () => {
      cancelled = true
    }
  }, [userId, prefsScope])

  // Stay in lockstep with prefs changes from elsewhere (prejoin
  // dialog, in-call device popover) so the panel never displays a
  // stale "don't ask again" or device pick.
  React.useEffect(() => {
    if (!userId) return
    return subscribeVoiceDevicePrefs(
      userId,
      (next) => {
        setPrefs(next)
      },
      prefsScope
    )
  }, [userId, prefsScope])

  const refreshDevices = React.useCallback(async () => {
    try {
      const result = await enumerateDevicesRaw()
      setDeviceList(result)
      return result
    } catch (error) {
      setPermissionError(
        error instanceof Error
          ? error.message
          : "Failed to enumerate media devices."
      )
      return null
    }
  }, [])

  React.useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  const restoreVoiceAfterMicTest = React.useCallback(async () => {
    const snapshot = isolationRef.current
    isolationRef.current = null
    if (!snapshot) return
    const runtime = voiceRuntimeRef.current
    if (!runtime?.isInVoice) return
    if (snapshot.appliedDeafen) {
      await Promise.resolve(runtime.onDeafen())
      return
    }
    if (snapshot.appliedMute) {
      await Promise.resolve(runtime.onMute())
    }
  }, [])

  const isolateVoiceForMicTest = React.useCallback(async () => {
    const runtime = voiceRuntimeRef.current
    if (!runtime?.isInVoice) return
    const snapshot: IsolationSnapshot = {
      appliedDeafen: false,
      appliedMute: false,
    }
    isolationRef.current = snapshot
    if (!runtime.isDeafened) {
      snapshot.appliedDeafen = true
      await Promise.resolve(runtime.onDeafen())
      return
    }
    if (!runtime.isMuted) {
      snapshot.appliedMute = true
      await Promise.resolve(runtime.onMute())
    }
  }, [])

  React.useEffect(() => {
    return () => {
      void stopMicMonitor().then(() => restoreVoiceAfterMicTest())
    }
  }, [stopMicMonitor, restoreVoiceAfterMicTest])

  // Smooth dB-meter animation. The worklet posts level samples at
  // ~188 Hz (`reportEveryNQuanta = 2` in noiseGateWorklet.js).
  // Rendering React state at that rate — or even at 60 Hz —
  // produces visible step jumps on the meter bar. Instead, drive
  // the fill width directly from a requestAnimationFrame loop with
  // a single-pole IIR smoother toward the latest sample.
  //
  // Time constants: near-instant attack so peaks land in one frame,
  // slow release so the bar coasts down. Both are independent of
  // the worklet's own attack/release on gain — this is purely the
  // visual smoother.
  const meterFillRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!isMicTesting) {
      // Reset bar to zero when the test stops so the UI doesn't
      // freeze at the last seen level.
      if (meterFillRef.current) meterFillRef.current.style.width = "0%"
      return
    }
    let raf = 0
    let displayed = 0
    let lastTimestamp = performance.now()
    // Single-pole IIR. alpha = 1 - exp(-dt / tau).
    // Near-instant attack so peaks land in one frame, slow release
    // so the bar coasts down.
    const ATTACK_TAU_MS = 5
    const RELEASE_TAU_MS = 100
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastTimestamp)
      lastTimestamp = now
      const target = micLevelRef.current ?? 0
      const tau = target > displayed ? ATTACK_TAU_MS : RELEASE_TAU_MS
      // Standard exponential approach: alpha = 1 - exp(-dt/tau).
      const alpha = 1 - Math.exp(-dt / tau)
      displayed = displayed + (target - displayed) * alpha
      if (meterFillRef.current) {
        meterFillRef.current.style.width = `${Math.max(
          0,
          Math.min(100, displayed)
        )}%`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isMicTesting, micLevelRef])

  const persistPrefs = React.useCallback(
    async (patch: Partial<Omit<VoiceDevicePrefs, "updatedAt">>) => {
      if (!userId) return
      const merged = mergeVoiceDevicePrefs(prefs, patch)
      setPrefs(merged)
      await saveVoiceDevicePrefs(userId, merged, prefsScope)
    },
    [prefs, userId, prefsScope]
  )

  const handleAudioDeviceChange = React.useCallback(
    async (value: string) => {
      const nextId = value === DEFAULT_OPTION_VALUE ? null : value
      await persistPrefs({ audioDeviceId: nextId })
      if (!isMicTesting) return
      try {
        await stopMicMonitor()
        await startMicMonitor({
          deviceId: nextId,
          settings: { noiseGateEnabled: false, noiseGateThresholdDb: -50 },
        })
      } catch (error) {
        // Mid-test mic switch failed — restore the room to its
        // pre-test state instead of leaving the user silently
        // deafened/muted.
        await stopMicMonitor()
        await restoreVoiceAfterMicTest()
        setMicTestError(new Error(getMicMonitorErrorMessage(error)))
      }
    },
    [
      isMicTesting,
      persistPrefs,
      restoreVoiceAfterMicTest,
      setMicTestError,
      startMicMonitor,
      stopMicMonitor,
    ]
  )

  const handleVideoDeviceChange = React.useCallback(
    async (value: string) => {
      const nextId = value === DEFAULT_OPTION_VALUE ? null : value
      await persistPrefs({ videoDeviceId: nextId })
    },
    [persistPrefs]
  )

  const handleOutputDeviceChange = React.useCallback(
    async (value: string) => {
      const nextId = value === DEFAULT_OPTION_VALUE ? null : value
      const runtime = voiceRuntimeRef.current
      // When in an active call we re-route the playback manager to
      // the new sink BEFORE persisting, so a failure (device gone,
      // permission denied, browser quirk) does not leave the saved
      // pref pointing at an output we cannot honour next time.
      if (runtime?.isInVoice && runtime.onOutputDeviceChange) {
        try {
          await Promise.resolve(runtime.onOutputDeviceChange(nextId))
        } catch (error) {
          setPermissionError(
            error instanceof Error
              ? `Could not switch output device: ${error.message}`
              : "Could not switch output device."
          )
          return
        }
      }
      await persistPrefs({ outputDeviceId: nextId })
      setPermissionError(null)
    },
    [persistPrefs]
  )

  const handleAskBeforeJoiningChange = React.useCallback(
    async (checked: boolean) => {
      // The persisted flag is the inverse: when "Ask before
      // joining" is checked, we should NOT skip the prejoin.
      await persistPrefs({ dontAskAgain: !checked })
    },
    [persistPrefs]
  )

  const handleGrantPermission = React.useCallback(
    async (kind: "audio" | "video") => {
      try {
        await requestMediaPermission(kind)
        setPermissionError(null)
        await refreshDevices()
      } catch (error) {
        setPermissionError(
          error instanceof Error
            ? error.message
            : "Permission denied."
        )
      }
    },
    [refreshDevices]
  )

  const handleMicTestToggle = React.useCallback(async () => {
    if (isMicTesting) {
      await stopMicMonitor()
      await restoreVoiceAfterMicTest()
      return
    }
    try {
      await isolateVoiceForMicTest()
      await startMicMonitor({
        deviceId: prefs?.audioDeviceId ?? null,
        // Hush noise gate is disabled until the v2 DSP ships; the
        // monitor stays as a raw loopback level meter.
        settings: { noiseGateEnabled: false, noiseGateThresholdDb: -50 },
      })
      // Refresh labels (post-permission they become populated).
      await refreshDevices()
    } catch (error) {
      await restoreVoiceAfterMicTest()
      setMicTestError(new Error(getMicMonitorErrorMessage(error)))
    }
  }, [
    isMicTesting,
    isolateVoiceForMicTest,
    prefs?.audioDeviceId,
    refreshDevices,
    restoreVoiceAfterMicTest,
    setMicTestError,
    startMicMonitor,
    stopMicMonitor,
  ])

  const audioGranted = hasPermissionFor(deviceList.audio)
  const videoGranted = hasPermissionFor(deviceList.video)
  const audioValue = prefs?.audioDeviceId ?? DEFAULT_OPTION_VALUE
  const videoValue = prefs?.videoDeviceId ?? DEFAULT_OPTION_VALUE
  const outputValue = prefs?.outputDeviceId ?? DEFAULT_OPTION_VALUE
  const askBeforeJoining = prefs ? !prefs.dontAskAgain : true

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Voice & video</h2>
        <p className="text-sm text-muted-foreground">
          Pick the input devices, tune your mic processing, and verify
          everything before you join a call.
        </p>
      </div>

      <Separator />

      <DeviceCard
        title="Behaviour"
        description="What happens when you join a voice channel on this device."
      >
        <div className="flex items-start gap-3">
          <Checkbox
            id="ask-before-joining"
            checked={askBeforeJoining}
            disabled={!userId}
            onCheckedChange={(checked) =>
              handleAskBeforeJoiningChange(checked === true)
            }
          />
          <div className="flex flex-col gap-0.5">
            <Label
              htmlFor="ask-before-joining"
              className="text-sm font-medium"
            >
              Ask before joining a voice channel
            </Label>
            <span className="text-xs text-muted-foreground">
              Show the prejoin dialog (camera preview + device pickers)
              every time you enter a voice channel. Uncheck to skip it
              and connect with your saved devices.
            </span>
          </div>
        </div>
      </DeviceCard>

      <DeviceCard
        title="Devices"
        description="Apply to every voice channel you join from this browser."
      >
        <DeviceRow
          icon={<MicIcon className="size-4" />}
          label="Microphone"
          control={
            audioGranted ? (
              <Select
                value={audioValue}
                onValueChange={handleAudioDeviceChange}
                disabled={!userId}
              >
                <SelectTrigger
                  aria-label="Microphone"
                  className="w-full sm:w-72"
                >
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_OPTION_VALUE}>
                    {formatDefaultOptionLabel(deviceList.audio)}
                  </SelectItem>
                  {deviceList.audio
                    .filter(
                      (d) =>
                        d.deviceId !== "default" &&
                        d.deviceId !== "communications"
                    )
                    .map((d, index) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {formatDeviceLabel(d, "Microphone", index)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleGrantPermission("audio")}
              >
                Grant microphone access
              </Button>
            )
          }
        />
        <Separator />
        <DeviceRow
          icon={<VideoIcon className="size-4" />}
          label="Camera"
          control={
            videoGranted ? (
              <Select
                value={videoValue}
                onValueChange={handleVideoDeviceChange}
                disabled={!userId}
              >
                <SelectTrigger
                  aria-label="Camera"
                  className="w-full sm:w-72"
                >
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_OPTION_VALUE}>
                    {formatDefaultOptionLabel(deviceList.video)}
                  </SelectItem>
                  {deviceList.video
                    .filter(
                      (d) =>
                        d.deviceId !== "default" &&
                        d.deviceId !== "communications"
                    )
                    .map((d, index) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {formatDeviceLabel(d, "Camera", index)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleGrantPermission("video")}
              >
                Grant camera access
              </Button>
            )
          }
        />
        <Separator />
        <DeviceRow
          icon={<HeadphonesIcon className="size-4" />}
          label="Output"
          control={
            outputSelectable ? (
              audioGranted ? (
                // Browser only exposes labels for `audiooutput` after
                // any media permission is granted (mic counts), so we
                // gate the picker on `audioGranted` and surface the
                // same Grant CTA as the mic/camera rows when no
                // permission has been given yet.
                <Select
                  value={outputValue}
                  onValueChange={handleOutputDeviceChange}
                  disabled={!userId}
                >
                  <SelectTrigger
                    aria-label="Output"
                    className="w-full sm:w-72"
                  >
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_OPTION_VALUE}>
                      {formatDefaultOptionLabel(deviceList.output)}
                    </SelectItem>
                    {deviceList.output
                      .filter(
                        (d) =>
                          d.deviceId !== "default" &&
                          d.deviceId !== "communications"
                      )
                      .map((d, index) => (
                        <SelectItem key={d.deviceId} value={d.deviceId}>
                          {formatDeviceLabel(d, "Speakers", index)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleGrantPermission("audio")}
                >
                  Grant audio access
                </Button>
              )
            ) : (
              <Select disabled value={DEFAULT_OPTION_VALUE}>
                <SelectTrigger
                  aria-label="Output"
                  className="w-full sm:w-72"
                >
                  <SelectValue
                    placeholder={
                      isMobile ? "System default" : "Not supported"
                    }
                  >
                    {isMobile ? "System default" : "Not supported"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_OPTION_VALUE}>Default</SelectItem>
                </SelectContent>
              </Select>
            )
          }
        />
        {permissionError ? (
          <p role="alert" className="text-xs text-destructive">
            {permissionError}
          </p>
        ) : null}
        {!outputSelectable ? (
          <p className="text-xs text-muted-foreground">
            {isMobile
              ? "Output routing is managed by the system on mobile. Use the system audio controls to switch."
              : "Your browser does not expose output device selection. Use the OS-level audio settings to switch."}
          </p>
        ) : null}
      </DeviceCard>

      <DeviceCard
        title="Audio filters"
        description="Noise gate and advanced filters. Shipping soon."
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Audio filters</span>
          <span className="text-xs text-muted-foreground">
            We are temporarily relying on the browser's built-in audio
            processing. Our own filters will be available in an upcoming
            release.
          </span>
        </div>
      </DeviceCard>

      <DeviceCard
        title="Mic test"
        description="Hear your mic locally and check the input level."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Local monitor</span>
            <span className="text-xs text-muted-foreground">
              {voiceRuntime?.isInVoice
                ? "While active, the room is deafened and the local loopback is the only audible path."
                : "Plays only on this device. Does not publish to any room."}
            </span>
          </div>
          <Button
            type="button"
            variant={isMicTesting ? "secondary" : "default"}
            onClick={handleMicTestToggle}
          >
            {isMicTesting ? "Stop test" : "Start test"}
          </Button>
        </div>
        <div
          className="relative h-2 overflow-hidden rounded-full bg-muted"
          aria-label="Microphone input level"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(micLevelRef.current ?? 0)}
        >
          <div
            ref={meterFillRef}
            className="h-full rounded-full bg-primary will-change-[width]"
            style={{ width: "0%" }}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {isMicTesting
            ? "Monitoring locally"
            : "Start the test to hear your mic locally and check the input level."}
        </span>
        {micTestError ? (
          <p role="alert" className="text-xs text-destructive">
            {micTestError.message}
          </p>
        ) : null}
      </DeviceCard>
    </div>
  )
}

interface DeviceCardProps {
  title: string
  description: string
  children: React.ReactNode
}

function DeviceCard({ title, description, children }: DeviceCardProps) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        {children}
      </div>
    </section>
  )
}

interface DeviceRowProps {
  icon: React.ReactNode
  label: string
  control: React.ReactNode
}

function DeviceRow({ icon, label, control }: DeviceRowProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      {control}
    </div>
  )
}
