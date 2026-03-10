import type { Route } from './types'
import { QUOTE_TTL_BRIDGE } from '../config/providers'

export function isExpired(route: Route): boolean {
  return Date.now() > route.quoteExpiresAt
}

const USDT0_TIME_PREFERENCE_WINDOW_SEC = 30

function providerScore(route: Route): number {
  const token = route.steps[0]?.fromToken?.toUpperCase() ?? ''
  if (token === 'USDT') return route.provider === 'USDT0' ? 1 : 0
  return 0
}

/** Sort comparator: negative = a is better value, positive = b is better. */
export function compareForCheapestSort(a: Route, b: Route): number {
  const extCostA = a.steps.reduce((sum, s) => sum + s.gasCostUSD + (s.nativeFeeUSD ?? 0), 0)
  const extCostB = b.steps.reduce((sum, s) => sum + s.gasCostUSD + (s.nativeFeeUSD ?? 0), 0)
  const netA = a.amountReceivedUSD - extCostA
  const netB = b.amountReceivedUSD - extCostB
  const netDiff = netB - netA
  if (Math.abs(netDiff) > 1e-9) return netDiff

  const timeDiff = Math.abs(a.estimatedTime - b.estimatedTime)
  if (timeDiff <= USDT0_TIME_PREFERENCE_WINDOW_SEC) {
    const scoreDiff = providerScore(b) - providerScore(a)
    if (scoreDiff !== 0) return scoreDiff
  }

  const outputDiff = b.amountReceivedUSD - a.amountReceivedUSD
  if (outputDiff !== 0) return outputDiff

  return a.estimatedTime - b.estimatedTime
}

export function buildRoute(opts: {
  provider: string
  fromToken: string
  toToken: string
  fromChainId: number
  toChainId: number
  amountIn: string
  amountOut: string
  gasCostUSD: number
  feeUSD: number
  nativeFeeUSD?: number
  estimatedTime: number
  receivedUSD: number
  expiresAt?: number
  providerData?: unknown
}): Route {
  return {
    type: 'direct',
    provider: opts.provider,
    steps: [{
      action: 'bridge',
      provider: opts.provider,
      fromToken: opts.fromToken,
      toToken: opts.toToken,
      fromChain: opts.fromChainId,
      toChain: opts.toChainId,
      amountIn: opts.amountIn,
      amountOut: opts.amountOut,
      gasCostUSD: opts.gasCostUSD,
      feeUSD: opts.feeUSD,
      ...(opts.nativeFeeUSD ? { nativeFeeUSD: opts.nativeFeeUSD } : {}),
      estimatedTime: opts.estimatedTime,
    }],
    totalCostUSD: opts.feeUSD + opts.gasCostUSD + (opts.nativeFeeUSD ?? 0),
    estimatedTime: opts.estimatedTime,
    amountReceived: opts.amountOut,
    amountReceivedUSD: opts.receivedUSD,
    quoteExpiresAt: opts.expiresAt ?? Date.now() + QUOTE_TTL_BRIDGE,
    _providerData: opts.providerData,
  }
}
