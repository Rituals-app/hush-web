/**
 * Emoji picker wrapped in a shadcn Popover. Trigger is the existing
 * `SmilePlusIcon` button in the composer toolbar — previously
 * decorative, now wired to insert the chosen unicode codepoint at the
 * editor cursor via the parent's `onSelect` callback.
 *
 * `emoji-mart` and `@emoji-mart/data` are dynamically imported on
 * first open so the cold composer mount stays fast.
 */
import * as React from "react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface EmojiPickerPopoverProps {
  trigger: React.ReactNode
  onSelect: (native: string) => void
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}

interface EmojiMartSelection {
  native?: string
  shortcodes?: string
}

type EmojiMartPickerElement = HTMLElement & {
  update?: (props: Record<string, unknown>) => void
}

type EmojiMartPickerConstructor = new (
  props: Record<string, unknown>
) => EmojiMartPickerElement

interface EmojiMartModule {
  Picker: EmojiMartPickerConstructor
}

function resolveEmojiMartModule(mod: unknown): EmojiMartModule {
  const direct = mod as Partial<EmojiMartModule>
  if (typeof direct.Picker === "function") {
    return direct as EmojiMartModule
  }

  const withDefault = mod as { default?: Partial<EmojiMartModule> }
  if (typeof withDefault.default?.Picker === "function") {
    return withDefault.default as EmojiMartModule
  }

  throw new Error("emoji-mart Picker export is unavailable")
}

function EmojiMartPicker({
  Picker,
  data,
  onSelect,
}: {
  Picker: EmojiMartPickerConstructor
  data: unknown
  onSelect: (selection: EmojiMartSelection) => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const picker = new Picker({
      data,
      onEmojiSelect: onSelect,
      theme: "auto",
      previewPosition: "none",
      skinTonePosition: "search",
      navPosition: "bottom",
      // Rituals fork: fit a 360 px pane (36 px per emoji plus padding).
      ...(window.innerWidth < 400
        ? { perLine: Math.max(6, Math.floor((window.innerWidth - 40) / 36)) }
        : {}),
    })

    host.replaceChildren(picker)
    return () => {
      host.replaceChildren()
    }
  }, [Picker, data, onSelect])

  return <div ref={hostRef} />
}

export function EmojiPickerPopover({
  trigger,
  onSelect,
  align = "end",
  side = "top",
}: EmojiPickerPopoverProps) {
  const [open, setOpen] = React.useState(false)
  const [Picker, setPicker] =
    React.useState<EmojiMartPickerConstructor | null>(null)
  const [data, setData] = React.useState<unknown>(null)

  React.useEffect(() => {
    if (!open || Picker) return
    let cancelled = false
    Promise.all([
      import("emoji-mart"),
      import("@emoji-mart/data"),
    ]).then(([emojiMartMod, dataMod]) => {
      if (cancelled) return
      const { Picker: LoadedPicker } = resolveEmojiMartModule(emojiMartMod)
      setPicker(() => LoadedPicker)
      setData(dataMod.default ?? dataMod)
    })
    return () => {
      cancelled = true
    }
  }, [open, Picker])

  const handleSelect = React.useCallback(
    (selection: EmojiMartSelection) => {
      const native = selection?.native
      if (typeof native === "string" && native.length > 0) {
        onSelect(native)
        setOpen(false)
      }
    },
    [onSelect]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        collisionPadding={8}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
      >
        {Picker && data ? (
          <EmojiMartPicker
            Picker={Picker}
            data={data}
            onSelect={handleSelect}
          />
        ) : (
          <div className="rounded-md bg-popover p-4 text-xs text-muted-foreground shadow-md">
            Loading…
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
