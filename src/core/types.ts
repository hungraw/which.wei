export interface Chain {
  id: number
  name: string
  icon: string
  rpcUrl: string
  explorerUrl: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  nativeGasIsEth?: boolean
  cctpDomain?: number
  usdt0Supported?: boolean
}

export interface Token {
  symbol: string
  name: string
  icon: string
  chains: Record<number, { address: string; decimals: number }>
}

export interface Route {
  type: 'direct'
  provider: string
  steps: RouteStep[]
  totalCostUSD: number
  estimatedTime: number
  amountReceived: string
  amountReceivedUSD: number
  quoteExpiresAt: number
  /** Opaque provider-specific data needed for execution. Avoids module-level cache. */
  _providerData?: unknown
  /** Optional UI-only annotation for loss badge rendering. */
  _uiLossPercent?: string
}

export interface RouteStep {
  action: 'swap' | 'bridge'
  provider: string
  fromToken: string
  toToken: string
  fromChain: number
  toChain: number
  amountIn: string
  amountOut: string
  gasCostUSD: number
  feeUSD: number
  /** External fee paid in native tokens, NOT deducted from bridge output (e.g. LayerZero messaging). */
  nativeFeeUSD?: number
  estimatedTime: number
  tx?: TxData
}

export interface TxData {
  to: string
  data: string
  value: string
  gasLimit?: string
}

export interface RouteComparison {
  fastest: Route | null
  cheapest: Route | null
  allRoutes: Route[]
}

export interface BridgeInput {
  amount: string
  token: Token
  fromChain: Chain
  toChain: Chain
  userAddress: string
  recipient?: string
}

type AppStatus = 'idle' | 'loading' | 'results' | 'executing' | 'complete' | 'error'

export interface BridgeParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export interface ExecuteResult {
  success: boolean
  txHash?: string
  destinationTxHash?: string
  pending?: boolean
  statusText?: string
  providerOrderId?: string
}

export type OnStep = (step: string) => void

export interface AppState {
  amount: string
  token: Token | null
  fromChain: Chain | null
  toChain: Chain | null
  routes: RouteComparison | null
  status: AppStatus
  error: string | null
  agentRecipient?: string
  agentRecipientName?: string
  agentRecipientNameType?: 'ens' | 'wns'
  agentProvider?: string
}

export function quoteParamsMatch(
  cached: { fromChainId: number; toChainId: number; amount: string; token: string } | null,
  current: { fromChainId: number; toChainId: number; amount: string; token: string },
): boolean {
  if (!cached) return false
  return cached.fromChainId === current.fromChainId
    && cached.toChainId === current.toChainId
    && cached.amount === current.amount
    && cached.token === current.token
}
