import * as React from "react"
import * as mlsStore from "@/lib/mlsStore"
import { getDeviceId } from "@/hooks/useAuth"
import { sweepLegacyPlaintextTags } from "@/lib/ritualsPlaintextTags"

/**
 * Rituals fork (2026-11-05): while this person is a member of the Space,
 * tag any legacy untagged cached plaintext with its channel so a later
 * removal can delete it. Best effort and silent: it never blocks or throws.
 */
export function useLegacyPlaintextTagSweep({
  instanceUrl,
  token,
  serverId,
  currentUserId,
  textChannelIds,
}: {
  instanceUrl: string
  token: string
  serverId: string
  currentUserId: string | null
  textChannelIds: string[]
}) {
  const channelKey = textChannelIds.join(",")
  React.useEffect(() => {
    if (!currentUserId || !token || !serverId || !channelKey) return
    const run = async () => {
      try {
        const db = (await mlsStore.openStore(currentUserId, getDeviceId())) as IDBDatabase
        await sweepLegacyPlaintextTags({
          db,
          token,
          serverId,
          channelIds: channelKey.split(","),
          baseUrl: instanceUrl,
        })
      } catch {
        // Best effort: the next mount tries again.
      }
    }
    void run()
  }, [currentUserId, token, serverId, instanceUrl, channelKey])
}
