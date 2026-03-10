import type { PollResult, TrackedBridge } from './types'
import { chainById } from '../config/chains'

const CCTP_IRIS_API = 'https://iris-api.circle.com'

const POLL_FETCH_TIMEOUT_MS = 10_000

function cctpInFlightLabel(forwardState?: string): string {
  const state = String(forwardState ?? '').toUpperCase()

  switch (state) {
    case 'PENDING':
      return 'Burn confirmed on source. Forwarding to destination...'
    case 'IN_PROGRESS':
      return 'Forwarding in progress on destination chain...'
    case 'SUCCEEDED':
      return 'Forward confirmed. Finalizing destination settlement...'
    default:
      return 'Attested. Waiting for destination forwarding...'
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = POLL_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    timeoutMs,
  )
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

function parseLayerZeroEtaSeconds(msg: Record<string, unknown> | null | undefined): number | undefined {
  const nowSec = Math.floor(Date.now() / 1000)
  const candidates = [
    msg?.['eta'],
    msg?.['etaSec'],
    msg?.['etaSeconds'],
    msg?.['estimatedArrival'],
    msg?.['estimatedArrivalAt'],
    msg?.['estimatedArrivalTime'],
    msg?.['estimatedDeliveryAt'],
    msg?.['estimatedDeliveryTime'],
    msg?.['estimatedExecutionAt'],
  ]

  for (const value of candidates) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) continue

    // Treat big values as epoch seconds and convert to remaining duration.
    if (numeric > 1_000_000_000) {
      const remaining = Math.floor(numeric - nowSec)
      if (remaining > 0) return remaining
      continue
    }

    // Already a duration-like value in seconds.
    if (numeric < 60 * 60 * 48) return Math.floor(numeric)
  }

  return undefined
}

// ============================================================================
// TIER 1: Confirmed REST APIs
// ============================================================================

/** Across — GET /deposit/status?depositTxnRef={txHash} */
async function pollAcross(bridge: TrackedBridge): Promise<PollResult> {
  const url = `https://app.across.to/api/deposit/status?depositTxnRef=${bridge.txHash}`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()
  if (data.status === 'filled') {
    return {
      status: 'complete',
      dstTxHash: data.fillTxnRef,
      dstChainId: data.destinationChainId,
    }
  }
  return { status: 'inflight' }
}

/** deBridge — Phase 1: get orderId, Phase 2: check order status */
async function pollDeBridge(bridge: TrackedBridge): Promise<PollResult> {
  // Phase 1: Get order ID if we don't have it
  if (!bridge.providerOrderId) {
    const idsUrl = `https://stats-api.dln.trade/api/Transaction/${bridge.txHash}/orderIds`
    const res = await fetchWithTimeout(idsUrl)
    if (!res.ok) return { status: 'pending' }

    const data = await res.json()
    if (!data.orderIds?.length) return { status: 'pending' }

    // Store the order ID for future polls (caller should update the bridge)
    return { status: 'inflight' }
  }

  // Phase 2: Check order status
  const statusUrl = `https://stats-api.dln.trade/api/Orders/${bridge.providerOrderId}`
  const res = await fetchWithTimeout(statusUrl)
  if (!res.ok) return { status: 'inflight' }

  const data = await res.json()
  const status = data.status ?? data.state

  if (status === 'Fulfilled' || status === 'SentUnlock' || status === 'ClaimedUnlock') {
    const dstTxHash = data.fulfilledDstEventMetadata?.transactionHash?.stringValue
      ?? data.fulfillTxHash ?? data.unlockTxHash
    return {
      status: 'complete',
      dstTxHash,
    }
  }
  if (status === 'OrderCancelled' || status === 'SentOrderCancel' || status === 'ClaimedOrderCancel') {
    return { status: 'failed', error: 'Order cancelled' }
  }
  return { status: 'inflight' }
}

/** Helper to get deBridge orderId (called separately to store in bridge) */
export async function getDebridgeOrderId(txHash: string): Promise<string | null> {
  try {
    const url = `https://stats-api.dln.trade/api/Transaction/${txHash}/orderIds`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return null
    const data = await res.json()
    return data.orderIds?.[0] ?? null
  } catch {
    return null
  }
}

/** Relay — GET /requests/v2?txHash={txHash}&user={addr} */
async function pollRelay(bridge: TrackedBridge): Promise<PollResult> {
  const url = `https://api.relay.link/requests/v2?txHash=${bridge.txHash}&user=${bridge.userAddress}`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()

  // API returns { requests: [...] }
  const requests = data.requests ?? (Array.isArray(data) ? data : [])
  const request = requests[0]
  if (!request) return { status: 'pending' }

  if (request.status === 'success') {
    const outTx = request.data?.outTxs?.[0]
    return {
      status: 'complete',
      dstTxHash: outTx?.hash ?? request.txHashes?.[0],
      dstChainId: outTx?.chainId ?? request.destinationChainId,
    }
  }
  if (request.status === 'failure') {
    return { status: 'failed', error: 'Relay fill failed' }
  }
  if (request.status === 'refunded') {
    return { status: 'failed', error: 'Refunded' }
  }
  return { status: 'inflight' }
}

/** cBridge — POST /v2/getTransferStatus */
async function pollCBridge(bridge: TrackedBridge): Promise<PollResult> {
  if (!bridge.providerOrderId) return { status: 'pending' }

  const res = await fetchWithTimeout('https://cbridge-prod2.celer.app/v2/getTransferStatus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transfer_id: bridge.providerOrderId }),
  })
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()
  if (data.err?.code) return { status: 'pending' }

  // Status 5 = TRANSFER_COMPLETED
  if (data.status === 5) {
    const dstLink = data.dst_block_tx_link ?? ''
    const dstMatch = dstLink.match(/\/tx\/(0x[a-fA-F0-9]+)/)
    return {
      status: 'complete',
      dstTxHash: dstMatch?.[1],
    }
  }
  // Status 6 = TO_BE_REFUNDED, Status 10 = REFUNDED
  if (data.status === 6 || data.status === 10) {
    return { status: 'failed', error: 'Refunded' }
  }
  return { status: 'inflight' }
}

/** CCTP Forwarding Service — poll Iris for attestation/forwarding completion */
async function pollCCTP(bridge: TrackedBridge): Promise<PollResult> {
  const sourceDomain = chainById.get(bridge.fromChainId)?.cctpDomain
  if (sourceDomain === undefined) return { status: 'pending' }

  const url = `${CCTP_IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${bridge.txHash}`
  const res = await fetchWithTimeout(url)

  if (res.status === 404 || res.status === 429 || res.status >= 500) {
    return { status: 'pending' }
  }
  if (!res.ok) {
    return { status: 'inflight', statusText: 'Circle status API temporarily unavailable' }
  }

  const data = await res.json() as { messages?: Array<{ status?: string; forwardState?: string; forwardTxHash?: string }> }
  const message = Array.isArray(data.messages) ? data.messages[0] : undefined
  if (!message) return { status: 'pending' }

  const messageStatus = String(message.status ?? '').toLowerCase()
  const forwardState = String(message.forwardState ?? '').toUpperCase()
  const forwardTxHash = message.forwardTxHash
  const hasForwardTxHash = typeof forwardTxHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(forwardTxHash)
  const forwardingSucceeded = forwardState === '' || forwardState === 'SUCCEEDED'

  if (hasForwardTxHash && forwardingSucceeded) {
    return {
      status: 'complete',
      dstTxHash: forwardTxHash,
      dstChainId: bridge.toChainId,
    }
  }

  if (forwardState === 'FAILED') {
    return {
      status: 'inflight',
      statusText: 'Forwarding attempt reverted. Waiting for retry...'
    }
  }

  if (messageStatus === 'complete') {
    return {
      status: 'inflight',
      statusText: cctpInFlightLabel(forwardState),
    }
  }

  return {
    status: 'inflight',
    statusText: 'Waiting for Circle attestation...'
  }
}

/** CCTP Slow — poll Iris for attestation only (no forwarding), transition to claim-ready */
async function pollCCTPSlow(bridge: TrackedBridge): Promise<PollResult> {
  const sourceDomain = chainById.get(bridge.fromChainId)?.cctpDomain
  if (sourceDomain === undefined) return { status: 'pending' }

  // If bridge already has a stored CCTP message (claim-ready state),
  // check on-chain first — catches claims by relayers/bots/user without relying on Iris
  if (bridge.cctpMessage && bridge.status === 'claim-ready') {
    const { isCCTPSlowAlreadyClaimed } = await import('../providers/cctp')
    const claimed = await isCCTPSlowAlreadyClaimed(bridge.toChainId, bridge.cctpMessage)
    if (claimed) {
      return { status: 'complete', dstChainId: bridge.toChainId }
    }
  }

  const url = `${CCTP_IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${bridge.txHash}`
  const res = await fetchWithTimeout(url)

  if (res.status === 404 || res.status === 429 || res.status >= 500) {
    return { status: 'pending' }
  }
  if (!res.ok) {
    return { status: 'inflight', statusText: 'Circle status API temporarily unavailable' }
  }

  const data = await res.json() as { messages?: Array<{ message?: string; attestation?: string; status?: string; recipientTxHash?: string; forwardTxHash?: string }> }
  const msg = Array.isArray(data.messages) ? data.messages[0] : undefined
  if (!msg) return { status: 'pending' }

  const messageStatus = String(msg.status ?? '').toLowerCase()
  const hasAttestation = typeof msg.message === 'string' && typeof msg.attestation === 'string'
    && msg.message.length > 2 && msg.attestation.length > 2

  // Check if someone (relayer/bot/user) already called receiveMessage
  const dstTx = msg.recipientTxHash || msg.forwardTxHash
  const alreadyClaimed = typeof dstTx === 'string' && /^0x[a-fA-F0-9]{64}$/.test(dstTx)

  if (alreadyClaimed) {
    return {
      status: 'complete',
      dstTxHash: dstTx,
      dstChainId: bridge.toChainId,
    }
  }

  if (messageStatus === 'complete' && hasAttestation) {
    // Check on-chain if the nonce has already been used (claimed by relayer/bot/user)
    const { isCCTPSlowAlreadyClaimed } = await import('../providers/cctp')
    const onChainClaimed = await isCCTPSlowAlreadyClaimed(bridge.toChainId, msg.message!)
    if (onChainClaimed) {
      return { status: 'complete', dstChainId: bridge.toChainId }
    }

    return {
      status: 'claim-ready',
      statusText: 'Attestation ready. Claim your USDC on the destination chain.',
      cctpMessage: msg.message!,
      cctpAttestation: msg.attestation!,
    } as PollResult & { cctpMessage: string; cctpAttestation: string }
  }

  return {
    status: 'inflight',
    statusText: 'Waiting for Circle attestation...'
  }
}

// ============================================================================
// TIER 2: Verified APIs
// ============================================================================

/** Stargate Taxi/Bus / USDT0 — LayerZero Scan API */
async function pollLayerZero(bridge: TrackedBridge): Promise<PollResult> {
  // Use the direct REST API instead of npm package
  const url = `https://api-mainnet.layerzero-scan.com/tx/${bridge.txHash}`
  const res = await fetchWithTimeout(url)

  if (!res.ok) {
    // Try the alternate trpc endpoint (may fail due to bot protection)
    try {
      const trpcUrl = `https://layerzeroscan.com/api/trpc/messages.list?input=${encodeURIComponent(JSON.stringify({ filters: { srcTxHash: bridge.txHash } }))}`
      const trpcRes = await fetchWithTimeout(trpcUrl)
      if (!trpcRes.ok) return { status: 'pending' }

      const trpcData = await trpcRes.json()
      const messages = trpcData?.result?.data?.messages ?? []
      if (!messages.length) return { status: 'pending' }

      const msg = messages[0]
      const statusText = String(msg.mainStatus ?? msg.status?.name ?? 'INFLIGHT').toUpperCase()
      const etaSeconds = parseLayerZeroEtaSeconds(msg)
      if (msg.mainStatus === 'DELIVERED' || msg.status?.name === 'DELIVERED') {
        return {
          status: 'complete',
          dstTxHash: msg.dstTxHash,
        }
      }
      if (msg.mainStatus === 'FAILED' || msg.status?.name === 'FAILED') {
        return { status: 'failed', error: 'LayerZero message failed' }
      }
      return { status: 'inflight', statusText, etaSeconds }
    } catch {
      return { status: 'pending' }
    }
  }

  const data = await res.json()
  const messages = data?.messages ?? []
  if (!messages.length) return { status: 'pending' }

  const msg = messages[0]
  const statusText = String(msg.status ?? msg.mainStatus ?? 'INFLIGHT').toUpperCase()
  const etaSeconds = parseLayerZeroEtaSeconds(msg)
  if (msg.status === 'DELIVERED') {
    return {
      status: 'complete',
      dstTxHash: msg.dstTxHash,
    }
  }
  if (msg.status === 'FAILED' || msg.status === 'PAYLOAD_STORED') {
    return { status: 'failed', error: msg.dstTxError ?? 'Message failed' }
  }
  return { status: 'inflight', statusText, etaSeconds }
}

/** Synapse — GET /destinationTx */
async function pollSynapse(bridge: TrackedBridge): Promise<PollResult> {
  const url = `https://api.synapseprotocol.com/destinationTx?originChainId=${bridge.fromChainId}&txHash=${bridge.txHash}`
  const res = await fetchWithTimeout(url)

  // 404 means pending
  if (res.status === 404) return { status: 'pending' }
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()

  if (data.status === 'completed' && data.toInfo?.txnHash) {
    return {
      status: 'complete',
      dstTxHash: data.toInfo.txnHash,
      dstChainId: data.toInfo.chainID,
    }
  }
  if (data.status === 'refunded') {
    return { status: 'failed', error: 'Refunded' }
  }
  return { status: 'inflight' }
}

/** Gas.zip — GET /v2/deposit/{srcTxHash} */
async function pollGasZip(bridge: TrackedBridge): Promise<PollResult> {
  const url = `https://backend.gas.zip/v2/deposit/${bridge.txHash}`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()
  if (!data.txs?.length) return { status: 'pending' }

  // Find the outbound tx matching our destination chain
  const outbound = data.txs.find((tx: { chain?: number; status?: string; hash?: string }) => tx.chain === bridge.toChainId)
  if (!outbound) return { status: 'pending' }

  if (outbound.status === 'CONFIRMED') {
    return {
      status: 'complete',
      dstTxHash: outbound.hash,
      dstChainId: outbound.chain,
    }
  }
  if (outbound.status === 'CANCELLED') {
    return { status: 'failed', error: 'Transaction cancelled' }
  }
  return { status: 'inflight' }
}

/** Orbiter — GET /transaction/{srcTxHash} */
async function pollOrbiter(bridge: TrackedBridge): Promise<PollResult> {
  const url = `https://openapi.orbiter.finance/transaction/${bridge.txHash}`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()
  if (!data.result) return { status: 'pending' }

  const tx = data.result

  // opStatus 99 = completed
  if (tx.opStatus === 99 && tx.targetId) {
    return {
      status: 'complete',
      dstTxHash: tx.targetId,
      dstChainId: parseInt(tx.targetChain),
    }
  }
  return { status: 'inflight' }
}

/** Mayan — GET /v3/swap/trx/{hash} */
async function pollMayan(bridge: TrackedBridge): Promise<PollResult> {
  const url = `https://explorer-api.mayan.finance/v3/swap/trx/${bridge.txHash}`
  const res = await fetchWithTimeout(url)
  if (!res.ok) return { status: 'pending' }

  const data = await res.json()

  if (data.clientStatus === 'COMPLETED') {
    return {
      status: 'complete',
      dstTxHash: data.fulfillTxHash,
    }
  }
  if (data.clientStatus === 'REFUNDED') {
    return { status: 'failed', error: 'Refunded' }
  }
  return { status: 'inflight' }
}

// ============================================================================
// TIER 3: Balance Polling Fallback (Eco only)
// ============================================================================

/** Eco — balance polling (no API available) */
export async function pollEco(
  bridge: TrackedBridge,
  getBalance: (chainId: number, token: string, address: string) => Promise<bigint>,
): Promise<PollResult> {
  if (!bridge.preBalance || !bridge.destTokenAddress) {
    // No pre-balance snapshot — can't detect arrival
    return { status: 'pending' }
  }

  const preBalance = BigInt(bridge.preBalance)
  const currentBalance = await getBalance(
    bridge.toChainId,
    bridge.destTokenAddress,
    bridge.userAddress,
  )

  // amountOut is stored as a raw smallest-unit integer string (e.g. USDC 6 decimals)
  const expectedAmount = BigInt(bridge.amountOut)

  // 90% threshold for ERC-20 stablecoins
  const threshold = (expectedAmount * 90n) / 100n
  const received = currentBalance - preBalance

  if (received >= threshold) {
    return { status: 'complete' }
  }
  return { status: 'pending' }
}

// ============================================================================
// Provider Router
// ============================================================================

const POLLERS: Record<string, (bridge: TrackedBridge) => Promise<PollResult>> = {
  'Across': pollAcross,
  'deBridge': pollDeBridge,
  'Relay': pollRelay,
  'cBridge': pollCBridge,
  'CCTP Fast': pollCCTP,
  'CCTP Slow': pollCCTPSlow,
  'Stargate Taxi': pollLayerZero,
  'Stargate Bus': pollLayerZero,
  'USDT0': pollLayerZero,
  'Synapse': pollSynapse,
  'Gas.zip': pollGasZip,
  'Orbiter': pollOrbiter,
  'Mayan Swift': pollMayan,
  'Mayan MCTP': pollMayan,
  'Mayan WH': pollMayan,
}

export function getPollerForProvider(provider: string): ((bridge: TrackedBridge) => Promise<PollResult>) | null {
  const poller = POLLERS[provider]
  if (poller) return poller
  // Eco requires balance getter, handled separately in manager
  if (provider !== 'Eco') console.warn(`[tracking] No poller for provider: ${provider}`)
  return null
}

// ms
export const POLL_INTERVALS: Record<string, number> = {
  'Across': 10_000,
  'deBridge': 5_000,
  'Relay': 10_000,
  'cBridge': 10_000,
  'CCTP Fast': 5_000,
  'CCTP Slow': 15_000,
  'Stargate Taxi': 4_000,
  'Stargate Bus': 4_000,
  'USDT0': 15_000,
  'Synapse': 5_000,
  'Gas.zip': 3_000,
  'Orbiter': 4_000,
  'Mayan Swift': 5_000,
  'Mayan MCTP': 5_000,
  'Mayan WH': 5_000,
  'Eco': 4_000,
}

// ms
export const MAX_POLL_DURATION: Record<string, number> = {
  'Across': 15 * 60_000,    // 15 min
  'deBridge': 10 * 60_000,  // 10 min
  'Relay': 15 * 60_000,     // 15 min
  'cBridge': 10 * 60_000,   // 10 min
  'CCTP Fast': 20 * 60_000,      // 20 min (attestation + forwarding)
  'CCTP Slow': 2 * 60 * 60_000,   // 2 hours (keeps polling during claim-ready)
  'Stargate Taxi': 20 * 60_000,  // 20 min
  'Stargate Bus': 20 * 60_000,   // 20 min
  'USDT0': 24 * 60 * 60_000, // 24h
  'Synapse': 15 * 60_000,   // 15 min
  'Gas.zip': 5 * 60_000,    // 5 min
  'Orbiter': 5 * 60_000,    // 5 min
  'Mayan Swift': 5 * 60_000, // 5 min
  'Mayan MCTP': 5 * 60_000,
  'Mayan WH': 5 * 60_000,
  'Eco': 5 * 60_000,        // 5 min
}
