import * as React from "react"

import * as mlsGroup from "@/lib/mlsGroup"
import * as mlsStore from "@/lib/mlsStore"
import * as hushCrypto from "@/lib/hushCrypto"
import * as api from "@/lib/api"
import {
  withChannelMLSMutex,
  textChannelKey,
} from "@/lib/channelMLSMutex"
import { getDeviceId } from "@/hooks/useAuth"

interface WsClientLike {
  on: (event: string, handler: (data: unknown) => void) => void
  off: (event: string, handler: (data: unknown) => void) => void
}

interface MlsCommitFrame {
  type?: string
  channel_id?: string
  epoch?: number
  commit_bytes?: string
  sender_id?: string
  sender_device_id?: string
  group_type?: "text" | "voice" | string
}

interface MlsAddRequestFrame {
  type?: string
  channel_id?: string
  action?: string
  proposal_bytes?: string
  requester_id?: string
  /**
   * Device id of the requester. Required for `action === "remove"`
   * because MLS leaf identities are `userId:deviceId` (see
   * `uploadKeyPackages.js`). Without it we cannot target the exact
   * departed leaf and must fall back to a catch-up — passing the
   * bare user id would either miss the leaf entirely or, worse,
   * remove the wrong one.
   */
  requester_device_id?: string
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface UseTextChannelMLSCommitListenerArgs {
  wsClient: WsClientLike | null | undefined
  currentUserId: string | null
  /** Returns the JWT for the active instance. Null when the user is
   *  not authenticated or has no session for the instance. */
  getToken: () => string | null
  /** Owning instance base URL. Threaded into MLS deps so the
   *  catch-up fallback (`getMLSCommitsSinceEpoch`) targets the
   *  per-instance JWT's owning origin instead of the current
   *  `window.location.origin`. Empty string preserves same-origin
   *  behaviour for callers that have not been migrated yet. */
  baseUrl?: string
}

/**
 * Subscribes the active session to text-channel MLS control frames
 * and applies them locally so the MLS group state advances in
 * lockstep with the network.
 *
 * Two events:
 *   - `mls.commit` (text channels) — peer committed an operation
 *     (member add/remove, key rotation). Decode `commit_bytes` and
 *     call `mlsGroup.processCommit`. Falls back to `catchupCommits`
 *     on failure.
 *   - `mls.add_request` with `action === "remove"` — a peer left and
 *     remaining online members must commit the removal. Whichever
 *     online member's listener fires first commits via
 *     `mlsGroup.removeMemberFromChannel`. Subsequent members observe
 *     the resulting `mls.commit` and advance via the listener above.
 *     "Already removed" / "unknown member" errors are logged as
 *     benign because another member won the race.
 *
 * Voice commits are filtered out (`group_type === "voice"`) — those
 * are handled in `useRoom.js` against the voice group state.
 *
 * Self-commits from the same device are skipped (the originator
 * already advanced its own state when sending). Same-user commits
 * from a different device DO process — the user's other devices
 * need to track the MLS group too.
 *
 * Mounts once at the authenticated app root. Channel-room
 * subscriptions are owned by `useTextChannelMLSSubscriptions`.
 */
export function useTextChannelMLSCommitListener({
  wsClient,
  currentUserId,
  getToken,
  baseUrl = "",
}: UseTextChannelMLSCommitListenerArgs): void {
  const tokenRef = React.useRef(getToken)
  tokenRef.current = getToken
  const userIdRef = React.useRef(currentUserId)
  userIdRef.current = currentUserId
  const baseUrlRef = React.useRef(baseUrl)
  baseUrlRef.current = baseUrl

  React.useEffect(() => {
    if (!wsClient) return

    async function buildDeps(channelId: string) {
      const userId = userIdRef.current
      const token = tokenRef.current?.()
      if (!userId || !token) return null
      const db = await mlsStore.openStore(userId, getDeviceId())
      if (!db) return null
      const credential = await mlsStore.getCredential(db)
      return {
        db,
        token,
        credential,
        mlsStore,
        hushCrypto,
        api,
        baseUrl: baseUrlRef.current,
      }
    }

    const onCommit = async (raw: unknown) => {
      const data = raw as MlsCommitFrame
      if (!data?.channel_id || !data.commit_bytes) return
      if (data.group_type === "voice") return
      const userId = userIdRef.current
      if (
        userId &&
        data.sender_id === userId &&
        data.sender_device_id === getDeviceId()
      ) {
        return
      }

      const channelId = data.channel_id
      try {
        const deps = await buildDeps(channelId)
        if (!deps) return
        const commitBytes = base64ToUint8Array(data.commit_bytes)
        await withChannelMLSMutex(textChannelKey(channelId), async () => {
          try {
            await mlsGroup.processCommit(deps, channelId, commitBytes)
          } catch (err) {
            console.warn(
              "[mls] processCommit failed; falling back to catchupCommits",
              { channelId, err: err instanceof Error ? err.message : err },
            )
            try {
              await mlsGroup.catchupCommits(deps, channelId)
            } catch (catchupErr) {
              console.warn("[mls] catchupCommits also failed", {
                channelId,
                err:
                  catchupErr instanceof Error
                    ? catchupErr.message
                    : catchupErr,
              })
            }
          }
        })
      } catch (err) {
        console.warn("[mls] commit listener: deps build failed", {
          channelId,
          err: err instanceof Error ? err.message : err,
        })
      }
    }

    const onAddRequest = async (raw: unknown) => {
      const data = raw as MlsAddRequestFrame
      if (!data?.channel_id || !data.requester_id) return
      if (data.action !== "remove") return
      const userId = userIdRef.current
      const requesterDeviceId = data.requester_device_id?.trim() || ""
      // Device-scoped self-skip: only suppress the local commit when
      // BOTH the user AND the device match. The same user on another
      // device must still process the removal — that device's MLS
      // leaf needs to be evicted from this device's group state too.
      if (
        userId &&
        data.requester_id === userId &&
        requesterDeviceId === getDeviceId()
      ) {
        return
      }

      const channelId = data.channel_id
      const requesterId = data.requester_id

      try {
        const deps = await buildDeps(channelId)
        if (!deps) return

        // Server-stamped device id absent (legacy server, or
        // unauthenticated WS client without a device id). MLS leaves
        // are identified by `userId:deviceId`, so removing on a bare
        // user id would either miss the leaf or remove the wrong
        // one. Catch up instead so any commit a peer eventually
        // makes will reach this device through the normal commit
        // stream.
        if (!requesterDeviceId) {
          console.warn(
            "[mls] add_request remove: legacy frame missing requester_device_id; falling back to catchupCommits",
            { channelId, requesterId },
          )
          await withChannelMLSMutex(textChannelKey(channelId), async () => {
            try {
              await mlsGroup.catchupCommits(deps, channelId)
            } catch (catchupErr) {
              console.warn("[mls] add_request remove: catchupCommits failed", {
                channelId,
                requesterId,
                err:
                  catchupErr instanceof Error
                    ? catchupErr.message
                    : catchupErr,
              })
            }
          })
          return
        }

        const memberIdentity = `${requesterId}:${requesterDeviceId}`
        await withChannelMLSMutex(textChannelKey(channelId), async () => {
          try {
            // Rituals fork (LANE-EF-WIRE D13): spread concurrent removers
            // and tell the server which pending removal this commit clears.
            await mlsGroup.removeMemberFromChannel(
              deps,
              channelId,
              memberIdentity,
              {
                removes: [{ userId: requesterId, deviceId: requesterDeviceId }],
                jitterMs: 1000,
              },
            )
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            // Benign races: another online member committed the
            // removal first, or the local group state already
            // reflects the removal because a prior `mls.commit`
            // arrived first. `unknown member` is deliberately NOT
            // benign — it usually signals the exact identity
            // mismatch this fix was created to surface (e.g. server
            // dropped device id, or wrong scope passed in), and
            // silencing it would let the leaf linger in the group.
            if (/already removed|not.*member/i.test(message)) {
              console.info("[mls] add_request remove: idempotent skip", {
                channelId,
                memberIdentity,
                message,
              })
              return
            }
            console.warn("[mls] removeMemberFromChannel failed", {
              channelId,
              memberIdentity,
              message,
            })
          }
        })
      } catch (err) {
        console.warn("[mls] add_request listener: deps build failed", {
          channelId,
          err: err instanceof Error ? err.message : err,
        })
      }
    }

    wsClient.on("mls.commit", onCommit)
    wsClient.on("mls.add_request", onAddRequest)
    return () => {
      wsClient.off("mls.commit", onCommit)
      wsClient.off("mls.add_request", onAddRequest)
    }
  }, [wsClient])
}
