import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock rpcRequest before importing analytics module
vi.mock('../src/utils/rpc', () => ({
  rpcRequest: vi.fn(),
}))

describe('analytics module', () => {
  let store: Map<string, string>

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Encode a BridgeInitiated log entry for eth_getLogs response */
  function makeBridgeLog(opts: {
    user: string
    target: string
    token: string
    amount: bigint
    destChainId: number
    blockNumber: number
  }) {
    const padAddr = (addr: string) => '0x' + addr.replace('0x', '').toLowerCase().padStart(64, '0')
    const padUint = (val: bigint) => val.toString(16).padStart(64, '0')
    return {
      topics: [
        '0x3c5e042a0b2a2ce43b45814f0e16283e2dc912d7024b71e57cfdf2afbaff3170',
        padAddr(opts.user),
        padAddr(opts.target),
        padAddr(opts.token),
      ],
      data: '0x' + padUint(opts.amount) + padUint(BigInt(opts.destChainId)),
      blockNumber: '0x' + opts.blockNumber.toString(16),
    }
  }

  // USDC on Ethereum
  const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  // Across SpokePool on Ethereum
  const ACROSS_ETH = '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5'
  // ETH sentinel for native bridges
  const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  // Relay on Ethereum
  const RELAY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'

  it('returns empty stats when no events exist', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)
    // eth_blockNumber returns deploy block (no new blocks)
    mockRpc.mockImplementation(async (_chainId, method) => {
      if (method === 'eth_blockNumber') return '0x' + (24524182).toString(16)
      if (method === 'eth_getLogs') return []
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats = await refreshAnalytics()

    expect(stats.totalBridges).toBe(0)
    expect(stats.uniqueUsers).toBe(0)
    expect(stats.byProvider).toEqual({})
    expect(stats.byToken).toEqual({})
    // byChain and byDestChain also empty
    expect(stats.byChain).toEqual({})
    expect(stats.byDestChain).toEqual({})
  })

  it('decodes BridgeInitiated events and aggregates stats', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const log1 = makeBridgeLog({
      user: '0x1111111111111111111111111111111111111111',
      target: ACROSS_ETH,
      token: USDC_ETH,
      amount: 100_000_000n, // 100 USDC (6 decimals)
      destChainId: 8453,
      blockNumber: 24524200,
    })
    const log2 = makeBridgeLog({
      user: '0x2222222222222222222222222222222222222222',
      target: RELAY,
      token: USDC_ETH,
      amount: 50_000_000n, // 50 USDC
      destChainId: 42161,
      blockNumber: 24524300,
    })

    mockRpc.mockImplementation(async (chainId, method) => {
      if (method === 'eth_blockNumber') {
        // Only Ethereum has new blocks
        if (chainId === 1) return '0x' + (24524500).toString(16)
        // All others at deploy block
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return [log1, log2]
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats = await refreshAnalytics()

    expect(stats.totalBridges).toBe(2)
    expect(stats.uniqueUsers).toBe(2)
    expect(stats.byProvider['Across']).toBe(1)
    expect(stats.byProvider['Relay']).toBe(1)
    expect(stats.byToken['USDC']).toBe(2)

  })

  it('resolves ETH sentinel for native bridges', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const log = makeBridgeLog({
      user: '0x3333333333333333333333333333333333333333',
      target: ACROSS_ETH,
      token: ETH_SENTINEL,
      amount: 1_000_000_000_000_000_000n, // 1 ETH
      destChainId: 10,
      blockNumber: 24524250,
    })

    mockRpc.mockImplementation(async (chainId, method) => {
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return [log]
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats = await refreshAnalytics()

    expect(stats.totalBridges).toBe(1)
    expect(stats.byToken['ETH']).toBe(1)

  })

  it('labels unknown targets as Unknown', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const log = makeBridgeLog({
      user: '0x4444444444444444444444444444444444444444',
      target: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      token: USDC_ETH,
      amount: 10_000_000n,
      destChainId: 137,
      blockNumber: 24524400,
    })

    mockRpc.mockImplementation(async (chainId, method) => {
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return [log]
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats = await refreshAnalytics()

    expect(stats.byProvider['Unknown']).toBe(1)
  })

  it('caches results in localStorage and returns cached on second call', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const log = makeBridgeLog({
      user: '0x1111111111111111111111111111111111111111',
      target: ACROSS_ETH,
      token: USDC_ETH,
      amount: 100_000_000n,
      destChainId: 8453,
      blockNumber: 24524200,
    })

    let rpcCallCount = 0
    mockRpc.mockImplementation(async (chainId, method) => {
      rpcCallCount++
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return [log]
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats1 = await refreshAnalytics()
    expect(stats1.totalBridges).toBe(1)

    const callsAfterFirst = rpcCallCount
    const stats2 = await refreshAnalytics()
    // Should return cached — no additional RPC calls
    expect(rpcCallCount).toBe(callsAfterFirst)
    expect(stats2.totalBridges).toBe(1)
  })

  it('re-fetches after cache TTL expires', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const log = makeBridgeLog({
      user: '0x1111111111111111111111111111111111111111',
      target: ACROSS_ETH,
      token: USDC_ETH,
      amount: 100_000_000n,
      destChainId: 8453,
      blockNumber: 24524200,
    })

    mockRpc.mockImplementation(async (chainId, method) => {
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return [log]
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    await refreshAnalytics()

    // Advance past TTL (5 min)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    let newRpcCalls = 0
    mockRpc.mockImplementation(async (chainId, method) => {
      newRpcCalls++
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') return []
      return null
    })

    await refreshAnalytics()
    expect(newRpcCalls).toBeGreaterThan(0)
  })

  it('counts dest chains correctly', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const logs = [
      makeBridgeLog({
        user: '0x1111111111111111111111111111111111111111',
        target: ACROSS_ETH,
        token: USDC_ETH,
        amount: 10_000_000n,
        destChainId: 8453, // Base
        blockNumber: 24524200,
      }),
      makeBridgeLog({
        user: '0x1111111111111111111111111111111111111111',
        target: ACROSS_ETH,
        token: USDC_ETH,
        amount: 20_000_000n,
        destChainId: 8453, // Base
        blockNumber: 24524201,
      }),
      makeBridgeLog({
        user: '0x1111111111111111111111111111111111111111',
        target: ACROSS_ETH,
        token: USDC_ETH,
        amount: 30_000_000n,
        destChainId: 42161, // Arbitrum
        blockNumber: 24524202,
      }),
    ]

    mockRpc.mockImplementation(async (chainId, method) => {
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return logs
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats = await refreshAnalytics()

    expect(stats.byDestChain['Base']).toBe(2)
    expect(stats.byDestChain['Arbitrum']).toBe(1)
    // Same user bridged 3 times
    expect(stats.uniqueUsers).toBe(1)
    expect(stats.totalBridges).toBe(3)
  })

  it('createAnalyticsPanel creates a div container', async () => {
    // Stub minimal DOM for createElement
    const div = { tagName: 'DIV', className: '', innerHTML: '' }
    vi.stubGlobal('document', { createElement: () => div })

    const { createAnalyticsPanel } = await import('../src/ui/analytics')
    const result = createAnalyticsPanel()

    expect(result.className).toBe('analytics-panel')
    vi.unstubAllGlobals()
  })

  it('handles malformed log data gracefully', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    const badLog = {
      topics: ['0x3c5e042a0b2a2ce43b45814f0e16283e2dc912d7024b71e57cfdf2afbaff3170'],
      data: '0x00', // too short
      blockNumber: '0x1',
    }
    const goodLog = makeBridgeLog({
      user: '0x1111111111111111111111111111111111111111',
      target: ACROSS_ETH,
      token: USDC_ETH,
      amount: 100_000_000n,
      destChainId: 8453,
      blockNumber: 24524200,
    })

    mockRpc.mockImplementation(async (chainId, method) => {
      if (method === 'eth_blockNumber') {
        if (chainId === 1) return '0x' + (24524500).toString(16)
        return '0x' + (1).toString(16)
      }
      if (method === 'eth_getLogs') {
        if (chainId === 1) return [badLog, goodLog]
        return []
      }
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    const stats = await refreshAnalytics()

    // Bad log skipped, only good log counted
    expect(stats.totalBridges).toBe(1)
  })

  it('survives RPC failures on individual chains', async () => {
    const rpc = await import('../src/utils/rpc')
    const mockRpc = vi.mocked(rpc.rpcRequest)

    mockRpc.mockImplementation(async (chainId, method) => {
      // Ethereum fails
      if (chainId === 1) throw new Error('RPC timeout')
      if (method === 'eth_blockNumber') return '0x' + (1).toString(16)
      if (method === 'eth_getLogs') return []
      return null
    })

    const { refreshAnalytics } = await import('../src/ui/analytics')
    // Should not throw, just return empty stats for failed chains
    const stats = await refreshAnalytics()
    expect(stats.totalBridges).toBe(0)
  })
})
