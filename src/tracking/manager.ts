import type { TrackedBridge, PollResult } from './types'
import {
  updateBridge,
  getActiveBridges,
  purgeExpired,
} from './store'
import {
  getPollerForProvider,
  getDebridgeOrderId,
  pollEco,
  POLL_INTERVALS,
  MAX_POLL_DURATION,
} from './poll'
import { chainById } from '../config/chains'
import { explorerTxUrl } from '../utils/format'

// Active poll timers by bridge ID
const activePolls = new Map<string, number>()

// Event name for UI updates
export const BRIDGE_UPDATE_EVENT = 'whichwei:bridge-update'

function dispatchUpdate(bridge: TrackedBridge) {
  window.dispatchEvent(new CustomEvent(BRIDGE_UPDATE_EVENT, { detail: bridge }))
}

function shortPollError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'TimeoutError') return 'Request timed out'
    if (err.name === 'AbortError') return 'Request aborted'
    return err.message || err.name
  }
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function startPolling(bridge: TrackedBridge): void {
  // Don't double-poll
  if (activePolls.has(bridge.id)) return
  
  // Don't poll completed/failed bridges
  if (bridge.status === 'completed' || bridge.status === 'failed' || bridge.status === 'unconfirmed') return

  // Notify UI immediately so pending indicators appear
  dispatchUpdate(bridge)
  
  const provider = bridge.provider
  const poller = getPollerForProvider(provider)
  const interval = POLL_INTERVALS[provider] ?? 5_000
  const maxDuration = MAX_POLL_DURATION[provider] ?? 10 * 60_000

  // If we can't poll this provider, don't start an interval that will run forever.
  // Mark the item as unconfirmed so the UI reflects that we can't verify completion.
  if (provider !== 'Eco' && !poller) {
    const now = Date.now()
    stopPolling(bridge.id)
    updateBridge(bridge.id, {
      status: 'unconfirmed',
      completedAt: now,
      lastError: 'No poller available for this provider',
      lastErrorAt: now,
      errorCount: 1,
    })
    dispatchUpdate({
      ...bridge,
      status: 'unconfirmed',
      completedAt: now,
      lastError: 'No poller available for this provider',
      lastErrorAt: now,
      errorCount: 1,
    })
    return
  }
  
  const startTime = bridge.startedAt
  let inFlight = false
  let backoffUntil = 0
  
  async function poll() {
    if (inFlight) return
    inFlight = true
    try {
      const tickNow = Date.now()
      if (tickNow < backoffUntil) return

      // Check if we've exceeded max duration
      const now = tickNow
      const elapsed = now - startTime
      if (elapsed > maxDuration) {
        // Stop polling — funds are committed, but we couldn't confirm completion.
        stopPolling(bridge.id)
        updateBridge(bridge.id, {
          status: 'unconfirmed',
          completedAt: now,
          lastError: 'Polling timed out',
          lastErrorAt: now,
        })
        dispatchUpdate({ ...bridge, status: 'unconfirmed' as const, completedAt: now, lastError: 'Polling timed out', lastErrorAt: now })
        return
      }

      let result: PollResult

      // Special handling for Eco (needs balance getter)
      try {
        if (provider === 'Eco') {
          result = await pollEco(bridge, getTokenBalance)
        } else if (poller) {
          result = await poller(bridge)
        } else {
          // Shouldn't happen due to the early guard above.
          return
        }
      } catch (err) {
        const msg = shortPollError(err).slice(0, 200)
        const nextCount = (bridge.errorCount ?? 0) + 1
        const backoffMs = Math.min(60_000, interval * Math.pow(2, Math.min(nextCount, 4)))
        backoffUntil = now + backoffMs

        bridge.errorCount = nextCount
        bridge.lastError = msg
        bridge.lastErrorAt = now
        updateBridge(bridge.id, { errorCount: nextCount, lastError: msg, lastErrorAt: now })
        dispatchUpdate({ ...bridge })
        return
      }

      // Successful poll — clear any prior error state.
      if (bridge.errorCount || bridge.lastError || bridge.lastErrorAt) {
        bridge.errorCount = 0
        bridge.lastError = undefined
        bridge.lastErrorAt = undefined
        updateBridge(bridge.id, { errorCount: 0, lastError: undefined, lastErrorAt: undefined })
        dispatchUpdate({ ...bridge })
      }

      const statusText = typeof result.statusText === 'string'
        ? result.statusText.trim().slice(0, 120)
        : undefined
      const etaSeconds = typeof result.etaSeconds === 'number' && Number.isFinite(result.etaSeconds)
        ? Math.max(0, Math.floor(result.etaSeconds))
        : undefined
      if (statusText !== undefined || etaSeconds !== undefined) {
        const metaUpdates: Partial<TrackedBridge> = {}
        if (statusText !== undefined && statusText !== bridge.providerStatusText) {
          metaUpdates.providerStatusText = statusText
          bridge.providerStatusText = statusText
        }
        if (etaSeconds !== undefined && etaSeconds !== bridge.providerEtaSec) {
          metaUpdates.providerEtaSec = etaSeconds
          bridge.providerEtaSec = etaSeconds
        }
        if (Object.keys(metaUpdates).length) {
          updateBridge(bridge.id, metaUpdates)
          dispatchUpdate({ ...bridge })
        }
      }
    
    // Handle deBridge orderId fetching
    if (provider === 'deBridge' && !bridge.providerOrderId && result.status === 'inflight') {
      const orderId = await getDebridgeOrderId(bridge.txHash)
      if (orderId) {
        updateBridge(bridge.id, { providerOrderId: orderId })
        bridge.providerOrderId = orderId
      }
    }
    
    switch (result.status) {
      case 'complete': {
        stopPolling(bridge.id)
        
        // Build destination explorer URL if we have the tx hash
        let destExplorerUrl: string | undefined
        const dstChainId = result.dstChainId ?? bridge.toChainId
        const dstChain = chainById.get(dstChainId)
        if (result.dstTxHash && dstChain) {
          destExplorerUrl = explorerTxUrl(dstChain.explorerUrl, result.dstTxHash) ?? undefined
        }
        
        updateBridge(bridge.id, {
          status: 'completed',
          completedAt: Date.now(),
          fillTxHash: result.dstTxHash,
          destExplorerUrl,
          providerEtaSec: undefined,
          providerStatusText: undefined,
        })
        
        const updated: TrackedBridge = {
          ...bridge,
          status: 'completed',
          completedAt: Date.now(),
          fillTxHash: result.dstTxHash,
          destExplorerUrl,
          providerEtaSec: undefined,
          providerStatusText: undefined,
        }
        dispatchUpdate(updated)
        break
      }
      
      case 'failed': {
        stopPolling(bridge.id)
        const failNow = Date.now()
        updateBridge(bridge.id, {
          status: 'failed',
          completedAt: failNow,
          lastError: result.error,
          lastErrorAt: failNow,
          providerEtaSec: undefined,
          providerStatusText: undefined,
        })
        const updated: TrackedBridge = {
          ...bridge,
          status: 'failed',
          completedAt: failNow,
          lastError: result.error,
          lastErrorAt: failNow,
          providerEtaSec: undefined,
          providerStatusText: undefined,
        }
        dispatchUpdate(updated)
        break
      }
      
      case 'inflight': {
        // Update status to processing if still 'sent'
        if (bridge.status === 'sent') {
          updateBridge(bridge.id, { status: 'processing' })
          bridge.status = 'processing'
          dispatchUpdate(bridge)
        }
        break
      }

      case 'claim-ready': {
        // CCTP Slow — attestation is available, user must manually claim.
        // Don't stop polling — keep checking if someone else claimed it.
        const claimUpdates: Partial<TrackedBridge> = {
          status: 'claim-ready' as TrackedBridge['status'],
          providerStatusText: result.statusText,
          providerEtaSec: undefined,
        }
        if (result.cctpMessage) claimUpdates.cctpMessage = result.cctpMessage
        if (result.cctpAttestation) claimUpdates.cctpAttestation = result.cctpAttestation
        updateBridge(bridge.id, claimUpdates)
        const claimBridge: TrackedBridge = { ...bridge, ...claimUpdates }
        dispatchUpdate(claimBridge)
        break
      }
      
      // 'pending' — keep polling
    }
    } finally {
      inFlight = false
    }
  }
  
  // Start immediately, then at interval
  void poll()
  const timerId = window.setInterval(poll, interval)
  activePolls.set(bridge.id, timerId)
}

export function stopPolling(bridgeId: string): void {
  const timerId = activePolls.get(bridgeId)
  if (timerId !== undefined) {
    window.clearInterval(timerId)
    activePolls.delete(bridgeId)
  }
}

export function resumePolling(): void {
  // First, purge expired completed bridges
  purgeExpired()
  
  // Get all bridges that need polling
  const bridges = getActiveBridges()
  
  for (const bridge of bridges) {
    startPolling(bridge)
  }
}

// Placeholder for balance getter (will be injected from main)
let getTokenBalance: (chainId: number, token: string, address: string) => Promise<bigint> = async () => 0n

// Eco polling needs a balance getter since there's no tracking API
export function setBalanceGetter(getter: (chainId: number, token: string, address: string) => Promise<bigint>): void {
  getTokenBalance = getter
}
