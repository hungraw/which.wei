import { describe, expect, it, vi } from 'vitest'
import type { Route } from '../src/core/types'
import { buildRoute } from '../src/core/quote'
import { QUOTE_TTL_BRIDGE } from '../src/config/providers'
import { selectFastestAndCheapest } from '../src/core/router'

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    type: 'direct',
    provider: 'Mock',
    steps: [{
      action: 'bridge',
      provider: 'Mock',
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChain: 1,
      toChain: 8453,
      amountIn: '1000000',
      amountOut: '995000',
      gasCostUSD: 0.5,
      feeUSD: 0.5,
      estimatedTime: 30,
    }],
    totalCostUSD: 1,
    estimatedTime: 30,
    amountReceived: '995000',
    amountReceivedUSD: 99.5,
    quoteExpiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

describe('core/quote build helpers', () => {
  it('buildRoute creates a direct route with expected totals and ttl', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-14T00:00:00.000Z'))

    const route = buildRoute({
      provider: 'Across',
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChainId: 1,
      toChainId: 8453,
      amountIn: '1000000',
      amountOut: '990000',
      gasCostUSD: 0.2,
      feeUSD: 0.1,
      estimatedTime: 45,
      receivedUSD: 0.99,
      providerData: { id: 1 },
    })

    expect(route.type).toBe('direct')
    expect(route.totalCostUSD).toBe(0.30000000000000004)
    expect(route.steps[0].provider).toBe('Across')
    expect(route.quoteExpiresAt).toBe(Date.now() + QUOTE_TTL_BRIDGE)
    expect(route._providerData).toEqual({ id: 1 })

    vi.useRealTimers()
  })

  it('buildRoute respects explicit expiresAt override', () => {
    const route = buildRoute({
      provider: 'Relay',
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChainId: 1,
      toChainId: 10,
      amountIn: '1000000',
      amountOut: '995000',
      gasCostUSD: 0.3,
      feeUSD: 0.2,
      estimatedTime: 60,
      receivedUSD: 0.995,
      expiresAt: 123456,
    })

    expect(route.quoteExpiresAt).toBe(123456)
  })

  it('selectFastestAndCheapest picks cheapest by net value after costs', () => {
    const fastest = makeRoute({ provider: 'Fast', estimatedTime: 15, amountReceivedUSD: 95, totalCostUSD: 1.0 })
    const cheapest = makeRoute({ provider: 'Cheap', estimatedTime: 40, amountReceivedUSD: 101, totalCostUSD: 1.5 })

    const selected = selectFastestAndCheapest([fastest, cheapest])
    expect(selected.fastest?.provider).toBe('Fast')
    expect(selected.cheapest?.provider).toBe('Cheap')
  })

  it('selectFastestAndCheapest uses output tie-break inside 1s fastest window', () => {
    const lowerOutput = makeRoute({ provider: 'A', estimatedTime: 30, amountReceivedUSD: 100 })
    const higherOutput = makeRoute({ provider: 'B', estimatedTime: 31, amountReceivedUSD: 101 })

    const selected = selectFastestAndCheapest([lowerOutput, higherOutput])
    expect(selected.fastest?.provider).toBe('B')
  })

  it('selectFastestAndCheapest prefers USDT0 near-tie for cheapest', () => {
    const other = makeRoute({
      provider: 'Other',
      estimatedTime: 35,
      amountReceivedUSD: 100,
      totalCostUSD: 1.0,
      steps: [{ ...makeRoute().steps[0], fromToken: 'USDT', gasCostUSD: 0.5 }],
    })
    const usdt0 = makeRoute({
      provider: 'USDT0',
      estimatedTime: 65,
      amountReceivedUSD: 100,
      totalCostUSD: 0.7,
      steps: [{ ...makeRoute().steps[0], fromToken: 'USDT', gasCostUSD: 0.5 }],
    })

    const selected = selectFastestAndCheapest([other, usdt0])
    expect(selected.cheapest?.provider).toBe('USDT0')
  })
})
