import * as React from "react"
import { SmilePlusIcon, SendHorizonalIcon } from "lucide-react"

import {
  ChatToolbar,
  ChatToolbarAddon,
  ChatToolbarButton,
  ChatToolbarAttachmentButton,
} from "@/components/chat/index"
import { EmojiPickerPopover } from "@/components/chat/emoji-picker-popover"
import { GifPickerPopover } from "@/components/chat/gif-picker-popover"
import {
  NovelComposer,
  type NovelComposerHandle,
} from "@/components/novel-composer"
import type { SlashAnchorRect } from "@/components/custom-slash-commands"
import { ATTACHMENT_FILE_INPUT_ACCEPT } from "@/lib/attachmentLimits"
import { SPACE_ATTACHMENTS_ENABLED } from "@/lib/ritualsSpace"
import type { GifRef } from "@/lib/messageEnvelope"

interface MessageComposerProps {
  channelName: string
  placeholder?: string
  onSend: (text: string) => void
  /** Files dropped from the attachment button. The parent owns upload
   *  state + AttachmentRef collection; the composer only forwards. */
  onFilesSelected?: (files: File[]) => void
  /** Block send while attachments are still uploading. Empty-text +
   *  attachments-ready is a valid send (envelope.text is allowed empty). */
  sendDisabled?: boolean
  attachmentDock?: React.ReactNode
  /** Required for the GIF picker network calls. */
  getToken?: () => string | null
  baseUrl?: string
  /** Fires when the user picks a GIF. Parent stages the GifRef into
   *  the next outbound envelope. */
  onPickGif?: (gif: GifRef) => void
}

export function MessageComposer({
  channelName,
  placeholder,
  onSend,
  onFilesSelected,
  sendDisabled,
  attachmentDock,
  getToken,
  baseUrl,
  onPickGif,
}: MessageComposerProps) {
  const composerRef = React.useRef<NovelComposerHandle>(null)
  const [isEmpty, setIsEmpty] = React.useState(true)
  const [gifOpen, setGifOpen] = React.useState(false)
  // The /gif slash command is the only entry point for the picker, so
  // we always position the popover at the caret. No toolbar button is
  // rendered — keeps the toolbar uncluttered.
  const [gifSlashAnchor, setGifSlashAnchor] =
    React.useState<SlashAnchorRect | null>(null)

  const gifAvailable = Boolean(getToken && onPickGif)

  const handleSlashOpenGif = React.useCallback(
    (anchor: SlashAnchorRect | null) => {
      setGifSlashAnchor(anchor)
      setGifOpen(true)
    },
    []
  )

  const handleGifOpenChange = React.useCallback((next: boolean) => {
    setGifOpen(next)
    if (!next) setGifSlashAnchor(null)
  }, [])

  return (
    <ChatToolbar>
      {attachmentDock ? (
        <ChatToolbarAddon align="block-start" className="w-full">
          {attachmentDock}
        </ChatToolbarAddon>
      ) : null}
      {SPACE_ATTACHMENTS_ENABLED ? (
        <ChatToolbarAddon align="inline-start">
          <ChatToolbarAttachmentButton
            accept={ATTACHMENT_FILE_INPUT_ACCEPT}
            onFilesSelected={onFilesSelected}
          />
        </ChatToolbarAddon>
      ) : null}
      <div className="order-2 flex min-w-0 flex-1 items-center self-center">
        <NovelComposer
          ref={composerRef}
          channelName={channelName}
          placeholder={placeholder}
          onSend={onSend}
          onEmptyChange={setIsEmpty}
          allowEmpty={Boolean(attachmentDock)}
          onOpenGif={gifAvailable ? handleSlashOpenGif : undefined}
        />
      </div>
      {gifAvailable ? (
        <GifPickerPopover
          open={gifOpen}
          onOpenChange={handleGifOpenChange}
          getToken={getToken!}
          baseUrl={baseUrl}
          onPick={(gif) => {
            onPickGif?.(gif)
            setGifOpen(false)
            setGifSlashAnchor(null)
          }}
          anchorRect={gifSlashAnchor}
        />
      ) : null}
      <ChatToolbarAddon align="inline-end">
        <EmojiPickerPopover
          trigger={
            <ChatToolbarButton aria-label="Add emoji" type="button">
              <SmilePlusIcon />
            </ChatToolbarButton>
          }
          onSelect={(native) => composerRef.current?.insertText(native)}
        />
        <ChatToolbarButton
          aria-label="Send"
          disabled={(isEmpty && !attachmentDock) || sendDisabled}
          onClick={() => composerRef.current?.send()}
        >
          <SendHorizonalIcon />
        </ChatToolbarButton>
      </ChatToolbarAddon>
    </ChatToolbar>
  )
}
