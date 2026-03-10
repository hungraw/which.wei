/**
 * Event Indexer — reads BridgeInitiated events from rAgg across all chains.
 * Aggregates stats (total bridges, volume by token, provider popularity),
 * caches in localStorage with incremental block tracking.
 */

import { rpcRequest } from '../utils/rpc'
import { RAGG_ADDRESS } from '../core/ragg'
import { chainById } from '../config/chains'
import { tokens } from '../config/tokens'

// ── Constants ────────────────────────────────────────────────

const STORAGE_KEY = 'whichway_analytics_v1'
const CACHE_TTL = 5 * 60 * 1000 // 5 min — rate friendly
const INITIAL_BLOCK_RANGE = 50_000 // starting range; auto-halved on RPC error
const MIN_BLOCK_RANGE = 200 // stop retrying below this
const MAX_EVENTS_PER_CHAIN = 2_000 // cap cached events to bound localStorage size

/**
 * Learned per-chain block range limits (persisted in memory for the session).
 * Starts at INITIAL_BLOCK_RANGE and halves each time an RPC rejects the range.
 */
const learnedBlockRange: Record<number, number> = {}

function getBlockRange(chainId: number): number {
  return learnedBlockRange[chainId] ?? INITIAL_BLOCK_RANGE
}

function shrinkBlockRange(chainId: number): number {
  const current = getBlockRange(chainId)
  const next = Math.max(MIN_BLOCK_RANGE, Math.floor(current / 2))
  learnedBlockRange[chainId] = next
  return next
}

/** BridgeInitiated(address indexed user, address indexed target, address indexed token, uint256 amount, uint256 destChainId) */
const BRIDGE_INITIATED_TOPIC = '0x3c5e042a0b2a2ce43b45814f0e16283e2dc912d7024b71e57cfdf2afbaff3170'

/** ETH sentinel address used in the event for native bridges */
const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

/** rAgg deployment blocks per chain — start scanning from here */
const DEPLOY_BLOCKS: Record<number, number> = {
  1: 24524182,
  8453: 42558318,
  42161: 435352038,
  10: 148153615,
  137: 83393011,
  999: 28112634,
  56: 83022789,
  57073: 38407676,
}

/** Known target addresses → provider name (lowercased for lookup) */
const TARGET_NAMES: Record<string, string> = {
  // Across SpokePools (per-chain)
  '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5': 'Across',
  '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64': 'Across',
  '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a': 'Across',
  '0x6f26bf09b1c792e3228e5467807a900a503c0281': 'Across',
  '0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096': 'Across',
  '0x35e63ea3eb0fb7a3bc543c71fb66412e1f6b0e04': 'Across',
  '0x4e8e101924ede233c13e2d8622dc8aed2872d505': 'Across',
  '0xef684c38f94f48775959ecf2012d7e864ffb9dd4': 'Across',
  // CCTP TokenMessengerV2
  '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d': 'CCTP',
  // Relay
  '0x4cd00e387622c35bddb9b4c962c136462338bc31': 'Relay',
  '0xf70da97812cb96acdf810712aa562db8dfa3dbef': 'Relay',
  // Gas.zip
  '0x391e7c679d29bd940d63be94ad22a25d25b5a604': 'Gas.zip',
  // deBridge
  '0xef4fb24ad0916217251f553c0596f8edc630eb66': 'deBridge',
  '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251': 'deBridge',
  // Eco
  '0x399dbd5df04f83103f77a58cba2b7c4d3cdede97': 'Eco',
  // Synapse
  '0xd5a597d6e7ddf373a92c8f477daaa673b0902f48': 'Synapse',
  '0x512000a034e154908efb1ec48579f4ffdb000512': 'Synapse',
  // Orbiter
  '0xe530d28960d48708ccf3e62aa7b42a80bc427aef': 'Orbiter',
  // Mayan
  '0x337685fdab40d39bd02028545a4ffa7d287cc3e2': 'Mayan',
  // USDT0
  '0x6c96de32cea08842dcc4058c14d3aaad7fa41dee': 'USDT0',
  '0x14e4a1b13bf7f943c8ff7c51fb60fa964a298d92': 'USDT0',
  '0xf03b4d9ac1d5d1e7c4cef54c2a313b9fe051a0ad': 'USDT0',
  // Stargate (selected pools — per-chain)
  '0xc026395860db2d07ee33e05fe50ed7bd583189c7': 'Stargate',
  '0x933597a323eb81cae705c5bc29985172fd5a3973': 'Stargate',
  '0x77b2043768d28e9c9ab44e1abfc95944bce57931': 'Stargate',
  '0x27a16dc786820b16e5c9028b75b99f6f604b5d26': 'Stargate',
  '0xdc181bd607330aeebef6ea62e03e5e1fb4b6f7c7': 'Stargate',
  '0xe8cdf27acd73a434d661c84887215f7598e7d0d3': 'Stargate',
  '0xce8cca271ebc0533920c83d39f417ed6a0abb7d0': 'Stargate',
  '0xa45b5130f36cdca45667738e2a258ab09f4a5f7f': 'Stargate',
  '0x19cfce47ed54a88614648dc3f19a5980097007dd': 'Stargate',
  '0x9aa02d4fae7f58b8e8f34c66e756cc734dac7fe4': 'Stargate',
  '0xd47b03ee6d86cf251ee7860fb2acf9f91b9fd4d7': 'Stargate',
  // cBridge (per-chain)
  '0x5427fefa711eff984124bfbb1ab6fbf5e3da1820': 'cBridge',
  '0x7d43aabc515c356145049227cee54b608342c0ad': 'cBridge',
  '0x1619de6b6b20ed217a58d00f37b9d47c7663feca': 'cBridge',
  '0x9d39fc627a6d9d9f8c831c16995b209548cc3401': 'cBridge',
  '0x88dcdc47d2f83a99cf0000fdf667a468bb958a78': 'cBridge',
  '0xdd90e5e87a2081dcf0391920868ebc2ffb81a1af': 'cBridge',
}

// ── Types ────────────────────────────────────────────────────

interface BridgeEvent {
  chainId: number
  user: string
  target: string
  token: string
  amount: bigint
  destChainId: number
  blockNumber: number
}

interface ChainCache {
  lastBlock: number
  events: Array<{
    user: string
    target: string
    token: string
    amount: string // hex bigint
    destChainId: number
    blockNumber: number
  }>
}

interface AnalyticsCache {
  ts: number
  chains: Record<string, ChainCache>
}

export interface AnalyticsStats {
  totalBridges: number
  uniqueUsers: number
  byProvider: Record<string, number>
  byToken: Record<string, number>
  byChain: Record<string, number> // source chain
  byDestChain: Record<string, number>
}

// ── Cache helpers ────────────────────────────────────────────

function loadCache(): AnalyticsCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ts: 0, chains: {} }
    return JSON.parse(raw) as AnalyticsCache
  } catch {
    return { ts: 0, chains: {} }
  }
}

function saveCache(cache: AnalyticsCache): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // localStorage full or blocked
  }
}

// ── Token resolution ─────────────────────────────────────────

/** Build a map of lowercase token address → { symbol, decimals } for a given chain */
function tokenMapForChain(chainId: number): Map<string, { symbol: string; decimals: number }> {
  const map = new Map<string, { symbol: string; decimals: number }>()
  for (const t of tokens) {
    const info = t.chains[chainId]
    if (info) map.set(info.address.toLowerCase(), { symbol: t.symbol, decimals: info.decimals })
  }
  // ETH sentinel
  map.set(ETH_SENTINEL, { symbol: 'ETH', decimals: 18 })
  return map
}

// ── Chain name helper ────────────────────────────────────────

function chainName(id: number): string {
  return chainById.get(id)?.name ?? `Chain ${id}`
}

function providerName(target: string): string {
  return TARGET_NAMES[target.toLowerCase()] ?? 'Unknown'
}

// ── Fetching ─────────────────────────────────────────────────

interface RpcLog {
  topics: string[]
  data: string
  blockNumber: string
}

interface FetchLogsResult {
  events: BridgeEvent[]
  /** The last block that was successfully scanned (inclusive) */
  lastScannedBlock: number
}

async function fetchLogsRange(
  chainId: number,
  fromBlock: number,
  toBlock: number,
): Promise<FetchLogsResult> {
  const events: BridgeEvent[] = []
  let cursor = fromBlock
  let lastScannedBlock = fromBlock - 1 // nothing scanned yet

  while (cursor <= toBlock) {
    const range = getBlockRange(chainId)
    const end = Math.min(cursor + range - 1, toBlock)
    try {
      const logs = await rpcRequest<RpcLog[]>(chainId, 'eth_getLogs', [{
        address: RAGG_ADDRESS,
        topics: [BRIDGE_INITIATED_TOPIC],
        fromBlock: '0x' + cursor.toString(16),
        toBlock: '0x' + end.toString(16),
      }])

      for (const log of logs) {
        if (log.topics.length < 4 || log.data.length < 130) continue
        const user = '0x' + log.topics[1].slice(26)
        const target = '0x' + log.topics[2].slice(26)
        const token = '0x' + log.topics[3].slice(26)
        const amount = BigInt('0x' + log.data.slice(2, 66))
        const destChainId = Number(BigInt('0x' + log.data.slice(66, 130)))
        const blockNumber = Number(log.blockNumber)
        events.push({ chainId, user, target, token, amount, destChainId, blockNumber })
      }
      lastScannedBlock = end
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
      const isRangeError = /block range|range.*(too large|exceed|limit)|too many|max.*block|exceed.*range|query returned more than/.test(msg)
      if (isRangeError && getBlockRange(chainId) > MIN_BLOCK_RANGE) {
        shrinkBlockRange(chainId)
        continue // retry same cursor with smaller range
      }
      // Non-range error or range already at minimum — stop scanning
      break
    }
    cursor = end + 1
  }

  return { events, lastScannedBlock }
}

async function getLatestBlock(chainId: number): Promise<number> {
  const hex = await rpcRequest<string>(chainId, 'eth_blockNumber')
  return Number(hex)
}

// ── Main indexing function ───────────────────────────────────

let indexingInFlight = false

export async function refreshAnalytics(): Promise<AnalyticsStats> {
  const cache = loadCache()

  // Return cached stats if fresh
  if (Date.now() - cache.ts < CACHE_TTL) {
    return computeStats(cache)
  }

  // Prevent concurrent indexing
  if (indexingInFlight) return computeStats(cache)
  indexingInFlight = true

  try {
    const chainIds = Object.keys(DEPLOY_BLOCKS).map(Number)

    // Fetch latest block + logs for each chain concurrently
    const results = await Promise.allSettled(
      chainIds.map(async (chainId) => {
        const chainCache = cache.chains[String(chainId)] ?? {
          lastBlock: DEPLOY_BLOCKS[chainId],
          events: [],
        }

        const latest = await getLatestBlock(chainId)
        const from = chainCache.lastBlock + 1
        if (from > latest) return { chainId, chainCache }

        const { events: newEvents, lastScannedBlock } = await fetchLogsRange(chainId, from, latest)
        const serialized = newEvents.map(e => ({
          user: e.user,
          target: e.target,
          token: e.token,
          amount: '0x' + e.amount.toString(16),
          destChainId: e.destChainId,
          blockNumber: e.blockNumber,
        }))

        // Only advance lastBlock to what was actually scanned (not latest)
        // so failed ranges are retried on next refresh
        const advanceTo = lastScannedBlock >= from ? lastScannedBlock : chainCache.lastBlock

        const merged = [...chainCache.events, ...serialized]

        return {
          chainId,
          chainCache: {
            lastBlock: advanceTo,
            // Keep only the most recent events to bound localStorage size
            events: merged.length > MAX_EVENTS_PER_CHAIN
              ? merged.slice(merged.length - MAX_EVENTS_PER_CHAIN)
              : merged,
          },
        }
      }),
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        cache.chains[String(result.value.chainId)] = result.value.chainCache
      }
    }

    cache.ts = Date.now()
    saveCache(cache)
  } finally {
    indexingInFlight = false
  }

  return computeStats(cache)
}

// ── Stats computation ────────────────────────────────────────

function computeStats(cache: AnalyticsCache): AnalyticsStats {
  const byProvider: Record<string, number> = {}
  const byToken: Record<string, number> = {}
  const byChain: Record<string, number> = {}
  const byDestChain: Record<string, number> = {}
  const users = new Set<string>()
  let totalBridges = 0

  for (const [chainIdStr, chainCache] of Object.entries(cache.chains)) {
    const chainId = Number(chainIdStr)
    const tokenMap = tokenMapForChain(chainId)
    const cName = chainName(chainId)

    for (const evt of chainCache.events) {
      totalBridges++
      users.add(evt.user)
      const provider = providerName(evt.target)
      byProvider[provider] = (byProvider[provider] ?? 0) + 1
      byChain[cName] = (byChain[cName] ?? 0) + 1

      const destName = chainName(evt.destChainId)
      byDestChain[destName] = (byDestChain[destName] ?? 0) + 1

      const tInfo = tokenMap.get(evt.token.toLowerCase())
      const symbol = tInfo?.symbol ?? 'Unknown'
      byToken[symbol] = (byToken[symbol] ?? 0) + 1
    }
  }

  return {
    totalBridges,
    uniqueUsers: users.size,
    byProvider,
    byToken,
    byChain,
    byDestChain,
  }
}

// ── UI Panel ─────────────────────────────────────────────────

function sortedEntries(obj: Record<string, number>): [string, number][] {
  return Object.entries(obj).sort((a, b) => b[1] - a[1])
}

function renderStats(stats: AnalyticsStats): string {
  const empty = stats.totalBridges === 0

  let html = `<div class="analytics-summary">`
  html += `<span class="analytics-stat">${empty ? '—' : stats.totalBridges} bridges</span>`
  html += `<span class="analytics-dot">·</span>`
  html += `<span class="analytics-stat">${empty ? '—' : stats.uniqueUsers} users</span>`
  html += `</div>`

  const topProviders = empty ? [] : sortedEntries(stats.byProvider).slice(0, 5)
  const topTokens = empty ? [] : sortedEntries(stats.byToken).slice(0, 5)
  const topChains = empty ? [] : sortedEntries(stats.byChain).slice(0, 5)

  const placeholder = '<div class="analytics-row analytics-placeholder"><span>—</span><span>—</span></div>'

  html += `<div class="analytics-grid">`

  // Top providers
  html += `<div class="analytics-col"><div class="analytics-label">Providers</div>`
  if (topProviders.length) {
    for (const [name, count] of topProviders) {
      const pct = Math.round((count / stats.totalBridges) * 100)
      html += `<div class="analytics-row"><span>${name}</span><span>${count} (${pct}%)</span></div>`
    }
  } else {
    html += placeholder.repeat(3)
  }
  html += `</div>`

  // Top tokens
  html += `<div class="analytics-col"><div class="analytics-label">Tokens</div>`
  if (topTokens.length) {
    for (const [name, count] of topTokens) {
      html += `<div class="analytics-row"><span>${name}</span><span>${count}</span></div>`
    }
  } else {
    html += placeholder.repeat(3)
  }
  html += `</div>`

  // Top source chains
  html += `<div class="analytics-col"><div class="analytics-label">From</div>`
  if (topChains.length) {
    for (const [name, count] of topChains) {
      html += `<div class="analytics-row"><span>${name}</span><span>${count}</span></div>`
    }
  } else {
    html += placeholder.repeat(3)
  }
  html += `</div>`

  html += `</div>`
  return html
}

/** Create an inline analytics panel pre-filled with skeleton placeholders. */
export function createAnalyticsPanel(): HTMLDivElement {
  const panel = document.createElement('div')
  panel.className = 'analytics-panel'
  // Show skeleton immediately so it's visible before data loads
  panel.innerHTML = renderStats({ totalBridges: 0, uniqueUsers: 0, byProvider: {}, byToken: {}, byChain: {}, byDestChain: {} })
  return panel
}

/** Load stats into the panel. Call when the panel becomes visible. */
export async function loadAnalyticsPanel(panel: HTMLDivElement): Promise<void> {
  panel.innerHTML = '<p class="analytics-loading">loading…</p>'
  try {
    const stats = await refreshAnalytics()
    panel.innerHTML = renderStats(stats)
  } catch {
    panel.innerHTML = '<p class="analytics-empty">Failed to load stats</p>'
  }
}
