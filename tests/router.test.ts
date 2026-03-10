import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BridgeInput, Route, Chain, Token } from '../src/core/types'

/**
 * Test the route aggregation engine — the core of whichwei.
 *
 * Mocks all 11 provider modules so we test ONLY the router logic:
 * - parallel fetching
 * - fastest/cheapest ranking
 * - tie-breaking by amountReceivedUSD
 * - error/null handling
 * - abort signal support
 * - onRoute streaming callback
 * - eligibility gating (CCTP only for USDC, etc.)
 */

// ─── Mock all providers ─────────────────────────────────────────────

vi.mock('../src/providers/cctp', () => ({
  getCCTPQuote: vi.fn().mockResolvedValue(null),
  getCCTPSlowQuote: vi.fn().mockResolvedValue(null),
}))
vi.mock('../src/providers/usdt0', () => ({
  getUSDT0Quote: vi.fn().mockResolvedValue(null),
  isUSDT0OftChain: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/across', () => ({
  getAcrossQuote: vi.fn().mockResolvedValue(null),
  isAcrossSupported: vi.fn().mockReturnValue(true),
}))
vi.mock('../src/providers/relay', () => ({
  getRelayQuote: vi.fn().mockResolvedValue(null),
  isRelaySupported: vi.fn().mockReturnValue(true),
}))
vi.mock('../src/providers/stargate', () => ({
  getStargateQuotes: vi.fn().mockResolvedValue([null, null]),
  isStargateSupported: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/cbridge', () => ({
  getCbridgeQuote: vi.fn().mockResolvedValue(null),
  isCbridgeSupported: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/debridge', () => ({
  getDebridgeQuote: vi.fn().mockResolvedValue(null),
  isDebridgeSupported: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/gaszip', () => ({
  getGasZipQuote: vi.fn().mockResolvedValue(null),
}))
vi.mock('../src/providers/eco', () => ({
  getEcoQuote: vi.fn().mockResolvedValue(null),
  isEcoSupported: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/synapse', () => ({
  getSynapseQuote: vi.fn().mockResolvedValue(null),
  isSynapseSupported: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/orbiter', () => ({
  getOrbiterQuote: vi.fn().mockResolvedValue(null),
  isOrbiterSupported: vi.fn().mockReturnValue(false),
}))
vi.mock('../src/providers/mayan', () => ({
  getMayanQuotes: vi.fn().mockResolvedValue([]),
  isMayanSupported: vi.fn().mockReturnValue(false),
}))

// Mock config/chains and config/tokens — router uses these for eligibility
vi.mock('../src/config/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/chains')>()
  return {
    ...actual,
    isCCTPSupported: vi.fn().mockReturnValue(true),
    isUSDT0Supported: vi.fn().mockReturnValue(false),
    isUSDT0OftChain: vi.fn().mockReturnValue(false),
  }
})
vi.mock('../src/config/tokens', () => ({
  getTokenAddress: vi.fn().mockReturnValue('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
}))

import { getRoutes } from '../src/core/router'
import { getAcrossQuote } from '../src/providers/across'
import { getCCTPQuote } from '../src/providers/cctp'
import { getRelayQuote } from '../src/providers/relay'
import { getStargateQuotes, isStargateSupported } from '../src/providers/stargate'
import { isCCTPSupported } from '../src/config/chains'
import { getTokenAddress } from '../src/config/tokens'

// ─── Helpers ────────────────────────────────────────────────────────

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    type: 'direct',
    provider: 'MockProvider',
    steps: [{
      action: 'bridge',
      provider: 'MockProvider',
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChain: 1,
      toChain: 8453,
      amountIn: '100000000',
      amountOut: '99500000',
      gasCostUSD: 0.5,
      feeUSD: 0.5,
      estimatedTime: 30,
    }],
    totalCostUSD: 1.0,
    estimatedTime: 30,
    amountReceived: '99500000',
    amountReceivedUSD: 99.5,
    quoteExpiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

function makeInput(overrides: Partial<BridgeInput> = {}): BridgeInput {
  return {
    amount: '100000000',
    token: {
      symbol: 'USDC',
      name: 'USD Coin',
      icon: '',
      chains: {
        1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
        8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      },
    },
    fromChain: {
      id: 1, name: 'Ethereum', icon: '', rpcUrl: '', explorerUrl: '',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      cctpDomain: 0,
    },
    toChain: {
      id: 8453, name: 'Base', icon: '', rpcUrl: '', explorerUrl: '',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      cctpDomain: 6,
    },
    userAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('getRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset defaults
    vi.mocked(isCCTPSupported).mockReturnValue(true)
    vi.mocked(getTokenAddress).mockReturnValue('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
    vi.mocked(isStargateSupported).mockReturnValue(false)
  })

  it('returns empty when all providers return null', async () => {
    const result = await getRoutes(makeInput())
    expect(result.fastest).toBeNull()
    expect(result.cheapest).toBeNull()
    expect(result.allRoutes).toEqual([])
  })

  it('returns single provider result as both fastest and cheapest', async () => {
    const route = makeRoute({ provider: 'Across', totalCostUSD: 1.0, estimatedTime: 30 })
    vi.mocked(getAcrossQuote).mockResolvedValueOnce(route)

    const result = await getRoutes(makeInput())
    expect(result.allRoutes).toHaveLength(1)
    expect(result.fastest).toBe(route)
    expect(result.cheapest).toBe(route)
  })

  it('picks correct fastest and cheapest from 3 routes', async () => {
    // Router chooses:
    // - fastest: lowest estimatedTime
    // - cheapest: highest amountReceivedUSD (ties broken by speed)
    const fast = makeRoute({ provider: 'Relay', totalCostUSD: 3.0, estimatedTime: 10, amountReceivedUSD: 97.0 })
    const cheap = makeRoute({ provider: 'CCTP', totalCostUSD: 0.5, estimatedTime: 900, amountReceivedUSD: 99.9 })
    const mid = makeRoute({ provider: 'Across', totalCostUSD: 1.5, estimatedTime: 30, amountReceivedUSD: 98.5 })

    vi.mocked(getCCTPQuote).mockResolvedValueOnce(cheap)
    vi.mocked(getAcrossQuote).mockResolvedValueOnce(mid)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(fast)

    const result = await getRoutes(makeInput())
    expect(result.allRoutes).toHaveLength(3)
    expect(result.fastest!.provider).toBe('Relay')
    expect(result.cheapest!.provider).toBe('CCTP')
  })

  it('breaks ties by amountReceivedUSD (higher wins)', async () => {
    const routeA = makeRoute({ provider: 'A', totalCostUSD: 1.0, estimatedTime: 30, amountReceivedUSD: 99.0 })
    const routeB = makeRoute({ provider: 'B', totalCostUSD: 1.0, estimatedTime: 30, amountReceivedUSD: 99.5 })

    vi.mocked(getAcrossQuote).mockResolvedValueOnce(routeA)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(routeB)

    const result = await getRoutes(makeInput())
    // Same cost, same time → prefer higher amountReceivedUSD
    expect(result.cheapest!.provider).toBe('B')
    expect(result.fastest!.provider).toBe('B')
  })

  it('gracefully handles provider errors (rejected promises)', async () => {
    const good = makeRoute({ provider: 'Across' })
    vi.mocked(getAcrossQuote).mockResolvedValueOnce(good)
    vi.mocked(getCCTPQuote).mockRejectedValueOnce(new Error('API down'))
    vi.mocked(getRelayQuote).mockRejectedValueOnce(new Error('timeout'))

    const result = await getRoutes(makeInput())
    expect(result.allRoutes).toHaveLength(1)
    expect(result.allRoutes[0].provider).toBe('Across')
  })

  it('filters out null results from providers', async () => {
    vi.mocked(getAcrossQuote).mockResolvedValueOnce(null)
    vi.mocked(getCCTPQuote).mockResolvedValueOnce(null)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(makeRoute({ provider: 'Relay' }))

    const result = await getRoutes(makeInput())
    expect(result.allRoutes).toHaveLength(1)
    expect(result.allRoutes[0].provider).toBe('Relay')
  })

  it('streams routes via onRoute callback as they resolve', async () => {
    const route1 = makeRoute({ provider: 'Across' })
    const route2 = makeRoute({ provider: 'Relay' })
    vi.mocked(getAcrossQuote).mockResolvedValueOnce(route1)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(route2)

    const streamed: Route[] = []
    await getRoutes(makeInput(), undefined, (r) => streamed.push(r))

    expect(streamed).toHaveLength(2)
    expect(streamed.map(r => r.provider).sort()).toEqual(['Across', 'Relay'])
  })

  it('skips CCTP when token is not USDC', async () => {
    const input = makeInput({
      token: {
        symbol: 'USDT',
        name: 'Tether USD',
        icon: '',
        chains: {
          1: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
          8453: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
        },
      },
    })

    vi.mocked(getAcrossQuote).mockResolvedValueOnce(makeRoute({ provider: 'Across' }))

    const result = await getRoutes(input)
    // CCTP should NOT have been called for USDT
    expect(getCCTPQuote).not.toHaveBeenCalled()
    expect(result.allRoutes).toHaveLength(1)
  })

  it('handles Stargate [taxi, bus] tuple results', async () => {
    vi.mocked(isStargateSupported).mockReturnValue(true)
    const taxi = makeRoute({ provider: 'Stargate Taxi', estimatedTime: 10, totalCostUSD: 2.0 })
    const bus = makeRoute({ provider: 'Stargate Bus', estimatedTime: 120, totalCostUSD: 0.3 })
    vi.mocked(getStargateQuotes).mockResolvedValueOnce([taxi, bus])

    const result = await getRoutes(makeInput())
    const sgRoutes = result.allRoutes.filter(r => r.provider === 'Stargate Taxi' || r.provider === 'Stargate Bus')
    expect(sgRoutes).toHaveLength(2)
  })

  // ─── Fastest route grace window (backlog P1) ─────────────────────

  it('fastest: within 1s grace → prefers higher value', async () => {
    // 2s vs 3s with vastly different value → within 1s grace, pick better value
    const routeA = makeRoute({ provider: 'A', estimatedTime: 2, amountReceivedUSD: 95.0 })
    const routeB = makeRoute({ provider: 'B', estimatedTime: 3, amountReceivedUSD: 99.0 })

    vi.mocked(getAcrossQuote).mockResolvedValueOnce(routeA)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(routeB)

    const result = await getRoutes(makeInput())
    // 3s - 2s = 1s ≤ grace window → prefer higher amountReceivedUSD
    expect(result.fastest!.provider).toBe('B')
  })

  it('fastest: large time gap → picks faster even with worse value', async () => {
    // 5s vs 60s → time gap 55s >> grace → pick faster
    const fast = makeRoute({ provider: 'Fast', estimatedTime: 5, amountReceivedUSD: 90.0 })
    const slow = makeRoute({ provider: 'Slow', estimatedTime: 60, amountReceivedUSD: 99.0 })

    vi.mocked(getAcrossQuote).mockResolvedValueOnce(fast)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(slow)

    const result = await getRoutes(makeInput())
    expect(result.fastest!.provider).toBe('Fast')
  })

  it('fastest: exactly 1s apart → still within grace window', async () => {
    const routeA = makeRoute({ provider: 'A', estimatedTime: 10, amountReceivedUSD: 80.0 })
    const routeB = makeRoute({ provider: 'B', estimatedTime: 11, amountReceivedUSD: 99.0 })

    vi.mocked(getAcrossQuote).mockResolvedValueOnce(routeA)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(routeB)

    const result = await getRoutes(makeInput())
    // |11 - 10| = 1 ≤ 1 → grace window → prefer higher value
    expect(result.fastest!.provider).toBe('B')
  })

  it('fastest: 2s apart → outside grace window, picks faster', async () => {
    const routeA = makeRoute({ provider: 'A', estimatedTime: 10, amountReceivedUSD: 80.0 })
    const routeB = makeRoute({ provider: 'B', estimatedTime: 12, amountReceivedUSD: 99.0 })

    vi.mocked(getAcrossQuote).mockResolvedValueOnce(routeA)
    vi.mocked(getRelayQuote).mockResolvedValueOnce(routeB)

    const result = await getRoutes(makeInput())
    // |12 - 10| = 2 > 1 → outside grace → prefer faster
    expect(result.fastest!.provider).toBe('A')
  })
})
