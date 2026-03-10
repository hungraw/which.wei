/**
 * Bridge order tracking types — defines the data model for tracking active bridges.
 */

export type TrackingStatus = 'sent' | 'processing' | 'completed' | 'failed' | 'unconfirmed' | 'claim-ready'

export interface TrackedBridge {
  id: string                    // unique ID (txHash-timestamp)
  txHash: string                // source chain tx hash
  provider: string              // e.g. 'Across', 'deBridge'
  token: string                 // e.g. 'USDC', 'ETH'
  fromChainId: number
  toChainId: number
  amountIn: string
  amountOut: string
  userAddress: string
  status: TrackingStatus
  startedAt: number             // timestamp when tx was sent
  estimatedTime: number         // seconds (from route.estimatedTime)
  completedAt?: number          // timestamp when filled
  fillTxHash?: string           // destination chain tx hash (if available)
  providerOrderId?: string      // deBridge orderId, etc.
  explorerUrl?: string          // source chain explorer link
  destExplorerUrl?: string      // dest chain explorer link (if fill tx known)
  /** Tracking diagnostics */
  lastError?: string
  lastErrorAt?: number
  errorCount?: number
  providerEtaSec?: number
  providerStatusText?: string
  /** CCTP Slow claim data — stored once attestation is ready */
  cctpMessage?: string
  cctpAttestation?: string
  /** For balance polling fallback (Eco) */
  preBalance?: string           // pre-bridge balance snapshot (stringified bigint)
  destTokenAddress?: string     // destination token address for balance polling
}

/** Result returned by provider-specific polling functions */
export interface PollResult {
  status: 'pending' | 'inflight' | 'complete' | 'failed' | 'claim-ready'
  dstTxHash?: string
  dstChainId?: number
  error?: string
  etaSeconds?: number
  statusText?: string
  /** CCTP Slow: message bytes for receiveMessage() */
  cctpMessage?: string
  /** CCTP Slow: attestation bytes for receiveMessage() */
  cctpAttestation?: string
}
