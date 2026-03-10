import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAIN_ID } from '../src/config/chains'

const readContractByRpc = vi.fn<[
  string,
], Promise<[bigint, bigint, bigint, bigint, bigint]>>()

const createPublicClientMock = vi.fn(({ transport }: { transport: { rpc: string } }) => ({
  readContract: () => readContractByRpc(transport.rpc),
}))

const httpMock = vi.fn((rpc: string) => ({ rpc }))

const formatUnitsMock = vi.fn((value: bigint, decimals: number) => {
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const frac = value % base
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString()
})

vi.mock('viem', () => ({
  createPublicClient: createPublicClientMock,
  http: httpMock,
  formatUnits: formatUnitsMock,
}))

describe('utils/prices', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('uses Chainlink first and DeFiLlama fallback for missing feeds', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    readContractByRpc.mockImplementation(async (rpc) => {
      if (rpc.includes('ethereum-rpc.publicnode.com')) {
        return [0n, 3000_00000000n, 0n, BigInt(nowSec), 0n]
      }
      throw new Error('bnb feed failed')
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        coins: {
          'coingecko:binancecoin': { price: 600 },
          'coingecko:polygon-ecosystem-token': { price: 1.25 },
          'coingecko:hyperliquid': { price: 32 },
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const prices = await import('../src/utils/prices')
    await prices.refreshPrices()

    expect(await prices.getNativeTokenPriceUSD(CHAIN_ID.ETHEREUM)).toBe(3000)
    expect(await prices.getNativeTokenPriceUSD(CHAIN_ID.BSC)).toBe(600)
    expect(await prices.getNativeTokenPriceUSD(CHAIN_ID.POLYGON)).toBe(1.25)
    expect(await prices.getNativeTokenPriceUSD(CHAIN_ID.HYPEREVM)).toBe(32)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches prices and avoids repeated upstream reads within TTL', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    readContractByRpc.mockResolvedValue([0n, 2000_00000000n, 0n, BigInt(nowSec), 0n])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))

    const prices = await import('../src/utils/prices')
    await prices.refreshPrices()
    await prices.refreshPrices()

    // two Chainlink feeds (ETH + BNB) fetched only once due cache
    expect(readContractByRpc).toHaveBeenCalledTimes(2)
  })

  it('converts native wei to USD when price is available', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    readContractByRpc.mockImplementation(async (rpc) => {
      if (rpc.includes('ethereum-rpc.publicnode.com')) {
        return [0n, 2500_00000000n, 0n, BigInt(nowSec), 0n]
      }
      throw new Error('skip')
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))

    const prices = await import('../src/utils/prices')
    const usd = await prices.nativeWeiToUSD(CHAIN_ID.ETHEREUM, 1_000000000000000000n)
    expect(usd).toBe(2500)
  })

  it('returns stablecoin and unknown token prices correctly', async () => {
    const prices = await import('../src/utils/prices')
    expect(await prices.getTokenPriceUSD('USDC', CHAIN_ID.BASE)).toBe(1)
    expect(await prices.getTokenPriceUSD('USDT', CHAIN_ID.BASE)).toBe(1)
    expect(await prices.getTokenPriceUSD('RANDOM', CHAIN_ID.BASE)).toBeNull()
  })
})
