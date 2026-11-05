/**
 * Real-data chat surface for an active text channel.
 *
 * Replaces the legacy `Chat.jsx` mount: the data plane lives in
 * `useChannelMessages` (MLS subscribe + history paging + send/retry +
 * reconnect catch-up) and the rendering reuses the prototype's
 * `chat/*` primitives + `MessageContent` (Streamdown markdown) +
 * `MessageComposer` (Novel editor with /slash commands and attachment
 * dock).
 *
 * Plaintext on the wire is now a v1 envelope: send wraps the
 * composer's markdown output as `{ v: 1, text: <markdown> }`, and
 * receive renders `envelope.text` through the same markdown pipeline
 * the prototype showed against mock data. Decryption failures (and v1
 * parse failures on the wire) render the recovery placeholder.
 */
import * as React from "react"
import {
  AlertTriangleIcon,
  FileIcon,
  Loader2Icon,
  UploadCloudIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  Chat,
  ChatEvent,
  ChatEventAddon,
  ChatEventAvatar,
  ChatEventBody,
  ChatEventContent,
  ChatEventTime,
  ChatEventTitle,
  ChatMessages,
} from "@/components/chat/index"
import { AttachmentTile } from "@/components/chat/attachment-tile"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { MessageContent } from "@/components/message-content"
import { MessageComposer } from "@/components/message-composer"
import { cn } from "@/lib/utils"
import { formatUserLabel } from "@/lib/userLabel"
import { SPACE_ATTACHMENTS_ENABLED } from "@/lib/ritualsSpace"
import { useChannelMessages, type ChatMessage } from "@/hooks/useChannelMessages"
import {
  useAttachmentUploader,
  type AttachmentUploadRejection,
  type UploadEntry,
} from "@/hooks/useAttachmentUploader"
import type { AttachmentRef, GifRef, MessageEnvelopeV1 } from "@/lib/messageEnvelope"

const RECOVERY_PLACEHOLDER =
  "Sent before this device joined the space. End-to-end encryption keeps it private."

interface ServerMember {
  id: string
  userId?: string
  username?: string | null
  displayName?: string | null
}

interface RealChatProps {
  channelId: string
  channelName: string
  serverId: string
  currentUserId: string
  getToken: () => string | null
  getStore: () => Promise<unknown> | unknown
  getHistoryStore?: () => Promise<unknown> | unknown
  wsClient: unknown
  members?: ServerMember[]
  baseUrl?: string
  markReadEnabled?: boolean
  onMarkRead?: ((channelId: string) => void) | null
  onNewMessage?: () => void
  maxAttachmentBytes?: number
}

const EMPTY_MEMBERS: ServerMember[] = []

export function RealChat({
  channelId,
  channelName,
  serverId,
  currentUserId,
  getToken,
  getStore,
  getHistoryStore,
  wsClient,
  members = EMPTY_MEMBERS,
  baseUrl = "",
  markReadEnabled = false,
  onMarkRead = null,
  onNewMessage,
  maxAttachmentBytes,
}: RealChatProps) {
  const displayNameMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const m of members) {
      const uid = m.userId ?? m.id
      const label = formatUserLabel({
        displayName: m.displayName,
        username: m.username,
        fallback: "",
      })
      if (uid && label) map.set(uid, label)
    }
    return map
  }, [members])

  const {
    messages,
    isInitialLoading,
    isChannelTransitioning,
    hasMoreOlder,
    loadMoreLoading,
    loadOlder,
    send,
    retry,
    consumeScrollRestore,
    recordScrollState,
  } = useChannelMessages({
    channelId,
    serverId,
    currentUserId,
    getToken,
    getStore,
    getHistoryStore,
    wsClient: wsClient as Parameters<typeof useChannelMessages>[0]["wsClient"],
    baseUrl,
    markRead: { enabled: markReadEnabled, onMarkRead },
    onNewMessage,
  })

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const dragDepthRef = React.useRef(0)
  const [isFileDragActive, setFileDragActive] = React.useState(false)

  const handleAttachmentRejected = React.useCallback(
    (rejection: AttachmentUploadRejection) => {
      toast.error(rejection.message)
    },
    []
  )

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el || loadMoreLoading || !hasMoreOlder) return
    // ChatMessages is flex-col-reverse, so the visual top corresponds
    // to scrollTop close to the negative of (scrollHeight - clientHeight).
    const distanceFromTop =
      el.scrollHeight - el.clientHeight - Math.abs(el.scrollTop)
    if (distanceFromTop < 80) {
      recordScrollState(el)
      void loadOlder()
    }
  }, [loadOlder, loadMoreLoading, hasMoreOlder, recordScrollState])

  React.useLayoutEffect(() => {
    const restore = consumeScrollRestore()
    const el = scrollRef.current
    if (!restore || !el) return
    if (restore.oldScrollHeight > 0) {
      el.scrollTop =
        el.scrollHeight - restore.oldScrollHeight + restore.oldScrollTop
    }
  }, [messages, consumeScrollRestore])

  const uploader = useAttachmentUploader({
    serverId,
    channelId,
    getToken,
    baseUrl,
    maxAttachmentBytes,
    onRejected: handleAttachmentRejected,
  })

  const [pendingGif, setPendingGif] = React.useState<GifRef | null>(null)

  const handleSend = React.useCallback(
    async (markdown: string) => {
      const refs = uploader.collectRefs()
      const trimmed = markdown.trim()
      // Block sends with no body and no attachments — the composer's
      // own disabled state usually catches this, but guard anyway.
      if (!trimmed && refs.length === 0 && !pendingGif) return
      // Composer rejects gif + attachments together so receivers do
      // not have to render both inside one bubble.
      const envelope: MessageEnvelopeV1 = {
        v: 1,
        text: trimmed,
        ...(refs.length > 0 ? { attachments: refs } : {}),
        ...(pendingGif && refs.length === 0 ? { gif: pendingGif } : {}),
      }
      try {
        await send(envelope)
        uploader.reset()
        setPendingGif(null)
      } catch (err) {
        console.error("[chat-real] send failed", err)
      }
    },
    [send, uploader, pendingGif]
  )

  const hasUploads = uploader.uploads.length > 0
  const sendDisabled = uploader.isUploading
  const attachmentDock =
    hasUploads || pendingGif ? (
      <ComposerDock
        uploads={uploader.uploads}
        onRemoveUpload={uploader.remove}
        onRetryUpload={uploader.retry}
        gif={pendingGif}
        onClearGif={() => setPendingGif(null)}
      />
    ) : null

  const groups = React.useMemo(() => groupConsecutive(messages), [messages])

  const messageBodyCtx = React.useMemo<MessageBodyContext>(
    () => ({ getToken, baseUrl }),
    [getToken, baseUrl]
  )

  const handleDragEnter = React.useCallback((event: React.DragEvent) => {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setFileDragActive(true)
  }, [])

  const handleDragOver = React.useCallback((event: React.DragEvent) => {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }, [])

  const handleDragLeave = React.useCallback((event: React.DragEvent) => {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setFileDragActive(false)
  }, [])

  const handleDrop = React.useCallback(
    (event: React.DragEvent) => {
      if (!dragEventHasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current = 0
      setFileDragActive(false)
      uploader.add(Array.from(event.dataTransfer.files))
    },
    [uploader]
  )

  return (
    <MessageBodyContext.Provider value={messageBodyCtx}>
      <Chat
        className="relative h-full"
        onDragEnter={SPACE_ATTACHMENTS_ENABLED ? handleDragEnter : undefined}
        onDragOver={SPACE_ATTACHMENTS_ENABLED ? handleDragOver : undefined}
        onDragLeave={SPACE_ATTACHMENTS_ENABLED ? handleDragLeave : undefined}
        onDrop={SPACE_ATTACHMENTS_ENABLED ? handleDrop : undefined}
      >
        {isFileDragActive ? <AttachmentDropOverlay /> : null}
        <ChatMessages
          ref={scrollRef as unknown as React.Ref<HTMLDivElement>}
          onScroll={handleScroll}
          aria-busy={isChannelTransitioning || isInitialLoading}
        >
          {isChannelTransitioning || isInitialLoading ? (
            <div className="flex flex-1 items-center justify-center py-10">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia className="text-muted-foreground" aria-hidden="true">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    focusable="false"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </EmptyMedia>
                <EmptyDescription>
                  no messages yet, start the conversation
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {groups
                .slice()
                .reverse()
                .map((group, revIdx, reversed) => {
                  const showDateSep =
                    revIdx === reversed.length - 1 ||
                    reversed[revIdx + 1].dateKey !== group.dateKey
                  return (
                    <React.Fragment key={group.head.id}>
                      {group.followups
                        .slice()
                        .reverse()
                        .map((m) => (
                          <FollowupMessage
                            key={m.id}
                            message={m}
                            onRetry={retry}
                          />
                        ))}
                      <PrimaryMessage
                        message={group.head}
                        currentUserId={currentUserId}
                        displayNameMap={displayNameMap}
                        onRetry={retry}
                      />
                      {showDateSep ? (
                        <DateSeparator
                          label={formatDateLabel(group.head.timestamp)}
                        />
                      ) : null}
                    </React.Fragment>
                  )
                })}
              {hasMoreOlder ? (
                <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
                  {loadMoreLoading ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    "Scroll up for older messages"
                  )}
                </div>
              ) : null}
            </>
          )}
        </ChatMessages>
        <MessageComposer
          key={channelId}
          channelName={channelName}
          onSend={handleSend}
          onFilesSelected={(files) => uploader.add(files)}
          sendDisabled={sendDisabled}
          attachmentDock={attachmentDock}
          getToken={getToken}
          baseUrl={baseUrl}
          onPickGif={(gif) => setPendingGif(gif)}
        />
      </Chat>
    </MessageBodyContext.Provider>
  )
}

function dragEventHasFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files")
}

function AttachmentDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border border-dashed border-primary/60 bg-background/85 shadow-lg backdrop-blur-sm">
      <div
        className="flex flex-col items-center gap-2 text-center"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UploadCloudIcon className="size-5" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium">Drop files to attach</p>
          <p className="text-xs text-muted-foreground">
            Files are staged here before encrypted upload.
          </p>
        </div>
      </div>
    </div>
  )
}

function ComposerDock({
  uploads,
  onRemoveUpload,
  onRetryUpload,
  gif,
  onClearGif,
}: {
  uploads: UploadEntry[]
  onRemoveUpload: (id: string) => void
  onRetryUpload: (id: string) => void
  gif: GifRef | null
  onClearGif: () => void
}) {
  return (
    <div className="flex w-full flex-wrap items-center gap-2 px-1 pb-1">
      {uploads.map((u) => (
        <UploadChip
          key={u.localId}
          entry={u}
          onRemove={onRemoveUpload}
          onRetry={onRetryUpload}
        />
      ))}
      {gif ? <GifPreviewChip gif={gif} onClear={onClearGif} /> : null}
    </div>
  )
}

function GifPreviewChip({
  gif,
  onClear,
}: {
  gif: GifRef
  onClear: () => void
}) {
  return (
    <div className="relative inline-flex overflow-hidden rounded-md border bg-muted/40">
      <img
        src={gif.previewUrl}
        alt=""
        className="h-16 w-auto"
        loading="lazy"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0.5 top-0.5 size-5 bg-background/80"
        onClick={onClear}
        aria-label="Remove GIF"
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  )
}

function UploadChip({
  entry,
  onRemove,
  onRetry,
}: {
  entry: UploadEntry
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  const failed = entry.status === "failed" || entry.status === "cancelled"
  return (
    <div
      className={cn(
        "flex max-w-xs items-center gap-2 rounded-md border bg-muted/40 p-1.5 text-xs",
        failed && "border-destructive/50"
      )}
      title={entry.errorMessage}
    >
      <LocalUploadPreview file={entry.file} failed={failed} />
      {failed ? (
        <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
      ) : entry.status === "ready" ? null : (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{entry.file.name}</span>
        {failed && entry.errorMessage ? (
          <span className="block truncate text-[11px] text-destructive">
            {entry.errorMessage}
          </span>
        ) : null}
      </span>
      {failed ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-[11px]"
          onClick={() => onRetry(entry.localId)}
        >
          Retry
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-5"
        onClick={() => onRemove(entry.localId)}
        aria-label={`Remove ${entry.file.name}`}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  )
}

function LocalUploadPreview({
  file,
  failed,
}: {
  file: File
  failed: boolean
}) {
  const objectUrl = useLocalObjectUrl(file)
  if (!objectUrl || failed) {
    return (
      <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
        <FileIcon className="size-4" />
      </span>
    )
  }
  if (file.type.startsWith("image/")) {
    return (
      <img
        src={objectUrl}
        alt=""
        className="size-9 shrink-0 rounded object-cover"
      />
    )
  }
  if (file.type.startsWith("video/")) {
    return (
      <video
        src={objectUrl}
        muted
        playsInline
        preload="metadata"
        className="size-9 shrink-0 rounded object-cover"
      />
    )
  }
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
      <FileIcon className="size-4" />
    </span>
  )
}

function useLocalObjectUrl(file: File): string | null {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (
      !file.type.startsWith("image/") &&
      !file.type.startsWith("video/")
    ) {
      setObjectUrl(null)
      return
    }
    const nextUrl = URL.createObjectURL(file)
    setObjectUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [file])

  return objectUrl
}

interface MessageGroup {
  dateKey: string
  head: ChatMessage
  followups: ChatMessage[]
}

const FIVE_MIN_MS = 5 * 60 * 1000

function groupConsecutive(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    const last = groups.at(-1)
    const sameDay =
      last && toDateKey(last.head.timestamp) === toDateKey(m.timestamp)
    const sameSender = last && last.head.sender === m.sender
    const inWindow =
      last && Math.abs(m.timestamp - last.head.timestamp) < FIVE_MIN_MS
    const noPending = last && !last.head.pending && !m.pending
    if (last && sameDay && sameSender && inWindow && noPending) {
      last.followups.push(m)
    } else {
      groups.push({ dateKey: toDateKey(m.timestamp), head: m, followups: [] })
    }
  }
  return groups
}

function toDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function formatDateLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (toDateKey(ts) === toDateKey(today.getTime())) return "Today"
  if (toDateKey(ts) === toDateKey(yesterday.getTime())) return "Yesterday"
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function truncateUserId(userId: string): string {
  if (!userId) return "User"
  return `${userId.slice(0, 8)}…`
}

function deriveInitials(name: string): string {
  return name
    .split(" ")
    .map((p) => p.charAt(0))
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

function PrimaryMessage({
  message,
  currentUserId,
  displayNameMap,
  onRetry,
}: {
  message: ChatMessage
  currentUserId: string
  displayNameMap: Map<string, string>
  onRetry: (id: string) => Promise<void>
}) {
  const isOwn = message.sender === currentUserId
  const displayName = isOwn
    ? "You"
    : displayNameMap.get(message.sender) ?? truncateUserId(message.sender)
  return (
    <ChatEvent
      data-message-id={message.id}
      className={cn(
        "group/event relative rounded-md py-1 transition-colors hover:bg-muted/60",
        message.pending && "opacity-60",
        message.failed && "border border-destructive/40"
      )}
    >
      <ChatEventAddon>
        <ChatEventAvatar
          fallback={deriveInitials(displayName)}
          fallbackProps={{ className: "text-xs" }}
        />
      </ChatEventAddon>
      <ChatEventBody>
        <ChatEventTitle>
          <span className="text-sm font-medium">{displayName}</span>
          <ChatEventTime
            timestamp={new Date(message.timestamp)}
            format="time"
            className="text-xs text-muted-foreground"
          />
          {message.pending ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              sending…
            </span>
          ) : null}
          {message.failed ? (
            <span className="text-[10px] uppercase tracking-wide text-destructive">
              failed
            </span>
          ) : null}
        </ChatEventTitle>
        <ChatEventContent>
          <MessageBody message={message} />
          {message.failed ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-7 text-xs"
              onClick={() => void onRetry(message.id)}
            >
              Retry
            </Button>
          ) : null}
        </ChatEventContent>
      </ChatEventBody>
    </ChatEvent>
  )
}

function FollowupMessage({
  message,
  onRetry,
}: {
  message: ChatMessage
  onRetry: (id: string) => Promise<void>
}) {
  return (
    <ChatEvent
      data-message-id={message.id}
      className={cn(
        "group/event relative rounded-md py-0.5 transition-colors hover:bg-muted/60",
        message.pending && "opacity-60",
        message.failed && "border border-destructive/40"
      )}
    >
      <ChatEventAddon>
        <ChatEventTime
          timestamp={new Date(message.timestamp)}
          format="time"
          className="opacity-0 text-[10px] text-muted-foreground group-hover/event:opacity-100 transition-opacity"
        />
      </ChatEventAddon>
      <ChatEventBody>
        <ChatEventContent>
          <MessageBody message={message} />
          {message.failed ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-7 text-xs"
              onClick={() => void onRetry(message.id)}
            >
              Retry
            </Button>
          ) : null}
        </ChatEventContent>
      </ChatEventBody>
    </ChatEvent>
  )
}

interface MessageBodyContext {
  getToken: () => string | null
  baseUrl: string
}

const MessageBodyContext = React.createContext<MessageBodyContext | null>(null)

function MessageBody({ message }: { message: ChatMessage }) {
  const ctx = React.useContext(MessageBodyContext)
  if (message.decryptionFailed || !message.envelope) {
    return (
      <span className="text-sm italic text-muted-foreground">
        {RECOVERY_PLACEHOLDER}
      </span>
    )
  }
  const { envelope } = message
  const hasText = envelope.text.length > 0
  const attachments = envelope.attachments ?? []
  return (
    <>
      {hasText ? <MessageContent body={envelope.text} /> : null}
      {envelope.gif ? <GifTile gif={envelope.gif} /> : null}
      {attachments.length > 0 && ctx ? (
        <div className="mt-2 flex flex-col gap-2">
          {attachments.map((a) => (
            <AttachmentTile
              key={a.id}
              ref={a as AttachmentRef}
              getToken={ctx.getToken}
              baseUrl={ctx.baseUrl}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

function GifTile({ gif }: { gif: GifRef }) {
  return (
    <img
      src={gif.url}
      alt=""
      width={gif.width}
      height={gif.height}
      loading="lazy"
      className="mt-2 max-w-sm rounded-md border bg-muted"
    />
  )
}

function DateSeparator({ label }: { label: string }) {
  return (
    <ChatEvent className="my-1 items-center gap-3">
      <Separator className="flex-1" />
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Separator className="flex-1" />
    </ChatEvent>
  )
}
