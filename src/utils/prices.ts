/**
 * Token USD prices — zero API keys.
 *
 * Primary:  Chainlink on-chain price feeds where available (ETH, BNB)
 * Fallback: DeFiLlama aggregator API (free, no auth, CORS-enabled)
 *
 * Cached for 5 minutes.
 */

import { createPublicClient, http, formatUnits } from 'viem'
import { STABLECOINS } from '../config/tokens'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const READ_TIMEOUT = 5_000 // 5s timeout per Chainlink read
const MAX_STALENESS = 3600 // 1 hour — reject prices older than this

const CHAINLINK_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

/** One feed per unique native token — ETH and BNB on-chain, POL via DeFiLlama. */
const CHAINLINK_FEEDS = {
  ethereum: {
    rpc: 'https://ethereum-rpc.publicnode.com',
    feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const, // ETH/USD on Ethereum
  },
  bnb: {
    rpc: 'https://bsc-rpc.publicnode.com',
    feed: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE' as const, // BNB/USD on BNB Chain
  },
} as const satisfies Record<string, { rpc: string; feed: `0x${string}` }>

import { CHAIN_ID } from '../config/chains'

/** Map chainId → which *native gas token* price is needed. */
const CHAIN_TO_TOKEN: Record<number, string> = {
  [CHAIN_ID.ETHEREUM]: 'ethereum',
  [CHAIN_ID.BASE]: 'ethereum',
  [CHAIN_ID.ARBITRUM]: 'ethereum',
  [CHAIN_ID.OPTIMISM]: 'ethereum',
  [CHAIN_ID.POLYGON]: 'pol',
  [CHAIN_ID.HYPEREVM]: 'hype',
  [CHAIN_ID.BSC]: 'bnb',
  [CHAIN_ID.INK]: 'ethereum',
}

const DEFILLAMA_URL =
  'https://coins.llama.fi/prices/current/' +
  'coingecko:ethereum,coingecko:binancecoin,coingecko:polygon-ecosystem-token,coingecko:hyperliquid' +
  '?searchWidth=4h'

const DEFILLAMA_KEY_MAP: Record<string, string> = {
  'coingecko:ethereum': 'ethereum',
  'coingecko:binancecoin': 'bnb',
  'coingecko:polygon-ecosystem-token': 'pol',
  'coingecko:hyperliquid': 'hype',
}

interface PriceCache {
  prices: Record<string, number> // token key ('ethereum'|'bnb'|'pol') → USD
  fetchedAt: number
}

let cache: PriceCache | null = null
let inflight: Promise<void> | null = null

const chainlinkClients = new Map<string, ReturnType<typeof createPublicClient>>()

function getChainlinkClient(rpc: string) {
  let client = chainlinkClients.get(rpc)
  if (!client) {
    client = createPublicClient({ transport: http(rpc, { timeout: READ_TIMEOUT }) })
    chainlinkClients.set(rpc, client)
  }
  return client
}

/**
 * Read a single Chainlink price feed via RPC.
 * Returns USD price (float) or null on failure.
 */
async function readChainlinkFeed(
  rpc: string,
  feed: `0x${string}`,
): Promise<number | null> {
  try {
    const client = getChainlinkClient(rpc)
    const result = await client.readContract({
      address: feed,
      abi: CHAINLINK_ABI,
      functionName: 'latestRoundData',
    })
    // result[1] = answer (int256 with 8 decimals), result[3] = updatedAt (uint256)
    const answer = result[1]
    const updatedAt = result[3]
    if (answer <= 0n) return null
    // Reject stale prices — updatedAt is a unix timestamp in seconds
    const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt)
    if (ageSec > MAX_STALENESS) {
      console.warn(`[prices] Chainlink feed ${feed} stale: ${ageSec}s old`)
      return null
    }
    const CHAINLINK_PRICE_PRECISION = 1e8
    return Number(answer) / CHAINLINK_PRICE_PRECISION
  } catch (err) {
    console.warn(`[prices] Chainlink feed ${feed} failed:`, err)
    return null
  }
}

async function fetchChainlinkPrices(): Promise<Record<string, number>> {
  const entries = Object.entries(CHAINLINK_FEEDS) as [
    keyof typeof CHAINLINK_FEEDS,
    (typeof CHAINLINK_FEEDS)[keyof typeof CHAINLINK_FEEDS],
  ][]

  const results = await Promise.allSettled(
    entries.map(async ([key, { rpc, feed }]) => {
      const price = await readChainlinkFeed(rpc, feed)
      return [key, price] as const
    }),
  )

  const prices: Record<string, number> = {}
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const [key, price] = r.value
      if (price !== null) prices[key] = price
    }
  }
  return prices
}

/** Fetch prices from DeFiLlama (fallback for failed Chainlink reads). */
async function fetchDeFiLlamaPrices(): Promise<Record<string, number>> {
  try {
    const res = await fetch(DEFILLAMA_URL, { signal: AbortSignal.timeout(READ_TIMEOUT) })
    if (!res.ok) return {}
    const data = await res.json()
    const prices: Record<string, number> = {}
    for (const [llamaKey, tokenKey] of Object.entries(DEFILLAMA_KEY_MAP)) {
      const price = data?.coins?.[llamaKey]?.price
      if (typeof price === 'number' && price > 0) {
        prices[tokenKey] = price
      }
    }
    return prices
  } catch (err) {
    console.warn('[prices] DeFiLlama fallback failed:', err)
    return {}
  }
}

/**
 * Refresh all native token prices.
 * Primary: Chainlink on-chain reads (3 parallel RPC calls).
 * Fallback: DeFiLlama API for any feeds that fail.
 * Exported so it can be called eagerly on app init.
 */
export async function refreshPrices(): Promise<void> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return
  if (inflight) return inflight

  inflight = (async () => {
    try {
      // 1. Try Chainlink (2 parallel on-chain reads: ETH, BNB)
      const prices = await fetchChainlinkPrices()

      // 2. Fall back to DeFiLlama for any missing prices (POL always comes from here)
      const needed = new Set(Object.values(CHAIN_TO_TOKEN))
      const missing = [...needed].filter((t) => !(t in prices))

      if (missing.length > 0) {
        const fallback = await fetchDeFiLlamaPrices()
        for (const key of missing) {
          if (key in fallback) prices[key] = fallback[key]
        }
      }

      // 3. Update cache (keep stale data if both sources fail entirely)
      if (Object.keys(prices).length > 0) {
        cache = { prices, fetchedAt: Date.now() }
      }
    } catch (err) {
      console.warn('[prices] Price refresh failed:', err)
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/**
 * Get the USD price of a chain's native token.
 * Returns null if price is unavailable.
 */
export async function getNativeTokenPriceUSD(chainId: number): Promise<number | null> {
  const tokenKey = CHAIN_TO_TOKEN[chainId]
  if (!tokenKey) return null

  await refreshPrices()
  return cache?.prices[tokenKey] ?? null
}

/**
 * Get ETH/USD regardless of the current chain.
 * Useful for WETH-as-ETH (e.g. Polygon) and any provider quoting in ETH units.
 */
async function getEthPriceUSD(): Promise<number | null> {
  await refreshPrices()
  return cache?.prices.ethereum ?? null
}

/**
 * Convert a native token amount (in wei) to USD.
 * Returns null if price is unavailable.
 */
export async function nativeWeiToUSD(chainId: number, weiAmount: bigint | string): Promise<number | null> {
  const price = await getNativeTokenPriceUSD(chainId)
  if (price === null) return null

  const wei = typeof weiAmount === 'string' ? BigInt(weiAmount) : weiAmount
  // Convert wei to ETH/BNB/etc (18 decimals) then multiply by USD price.
  // Avoid Number(BigInt) (precision/overflow) by formatting first.
  const nativeAmount = Number(formatUnits(wei, 18))
  if (!Number.isFinite(nativeAmount)) return null
  return nativeAmount * price
}

/**
 * Get the USD price of a token by symbol.
 * - Stablecoins: ~$1 (approximation)
 * - ETH: Uses native price feed
 * Returns null if price is unavailable.
 */
export async function getTokenPriceUSD(symbol: string, _chainId: number = 1): Promise<number | null> {
  const upper = symbol.toUpperCase()
  // Stablecoins — approximate as $1
  if (STABLECOINS.has(upper)) {
    return 1
  }
  // ETH — always use ETH/USD (even on chains where the native gas token isn't ETH, e.g. Polygon).
  // In this repo, token symbol 'ETH' can represent WETH on Polygon, which still tracks ETH price.
  if (upper === 'ETH') return getEthPriceUSD()
  // Unknown token — no price
  return null
}
