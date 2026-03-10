import { chainById, PUBLICNODE_RPC } from '../config/chains'

export type RpcProvider = 'default' | 'chainlist' | 'llamarpc' | 'drpc'

type ChainlistCache = {
  ts: number
  byChainId: Record<string, string[]>
}

type RpcSettings = {
  provider: RpcProvider
  customByChainId: Record<string, string>
  lastGoodByChainId: Record<string, string>
  lastGoodTsByChainId: Record<string, number>
  bestByChainId: Record<string, string>
  bestTsByChainId: Record<string, number>
  bestMsByChainId: Record<string, number>
}

const KEY_SETTINGS = 'whichway_rpc_settings_v1'
const KEY_CHAINLIST_CACHE = 'whichway_chainlist_rpc_cache_v1'

const CHAINLIST_CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
const BEST_RPC_CACHE_TTL = 30 * 60 * 1000 // 30 minutes
const BEST_RPC_PROBE_TIMEOUT_MS = 1400
const BEST_RPC_PROBE_MAX = 10
const PROVIDER_LATENCY_CACHE_TTL = 10 * 60 * 1000 // 10 minutes
const RPC_REQUEST_TIMEOUT_MS = 10_000
const LAST_GOOD_TTL = 24 * 60 * 60 * 1000 // 24 hours
const FAIL_THRESHOLD = 3 // consecutive failures before demoting a URL

const PUBLICNODE_BY_CHAIN = PUBLICNODE_RPC

// Static fallback RPCs for supported chains — used when chainlist.org + chainid.network both fail
const STATIC_FALLBACK_CACHE: ChainlistCache = {
  ts: 0,
  byChainId: {
    '1':     ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://eth.drpc.org'],
    '8453':  ['https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://base.drpc.org'],
    '42161': ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.llamarpc.com', 'https://arbitrum.drpc.org'],
    '10':    ['https://optimism-rpc.publicnode.com', 'https://optimism.llamarpc.com', 'https://optimism.drpc.org'],
    '137':   ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com', 'https://polygon.drpc.org'],
    '56':    ['https://bsc-rpc.publicnode.com', 'https://binance.llamarpc.com', 'https://bsc.drpc.org'],
    '999':   ['https://rpc.hyperliquid.xyz/evm'],
    '57073': ['https://rpc-gel.inkonchain.com'],
  },
}

let inMemorySettings: RpcSettings | null = null
let inMemoryChainlist: ChainlistCache | null = null
let inMemoryProviderLatency: Record<string, { ts: number; ms: number | null }> = {}
const failCounts: Record<string, number> = {} // url → consecutive failure count
let backgroundProbeInFlight: Record<string, boolean> = {} // chainId → in-flight flag

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\s+/g, '')
}

function sanitizeCustomRpcUrl(url: string): string | null {
  const cleaned = normalizeUrl(url)
  if (!cleaned) return null
  try {
    const u = new URL(cleaned)
    // Avoid URLs with embedded credentials.
    if (u.username || u.password) return null

    // Production CSP is https-only for connect-src; keep custom RPCs aligned.
    if (u.protocol === 'https:') return u.toString()

    // Allow localhost http for development / local nodes.
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return u.toString()
    }
    return null
  } catch {
    return null
  }
}

function uniq(urls: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const u of urls) {
    if (!u) continue
    const k = u.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(u)
  }
  return out
}

export function getRpcSettings(): RpcSettings {
  if (inMemorySettings) return inMemorySettings

  const parsed = safeJsonParse<Partial<RpcSettings>>(localStorage.getItem(KEY_SETTINGS))
  const rawProvider = (parsed?.provider ?? 'default') as unknown as string
  const provider = (rawProvider === 'publicnode' ? 'default' : rawProvider) as RpcProvider
  const customByChainId = parsed?.customByChainId ?? {}
  const lastGoodByChainId = parsed?.lastGoodByChainId ?? {}
  const lastGoodTsByChainId = parsed?.lastGoodTsByChainId ?? {}
  const bestByChainId = parsed?.bestByChainId ?? {}
  const bestTsByChainId = parsed?.bestTsByChainId ?? {}
  const bestMsByChainId = parsed?.bestMsByChainId ?? {}

  inMemorySettings = {
    provider: ['default', 'chainlist', 'llamarpc', 'drpc'].includes(provider)
      ? provider
      : 'default',
    customByChainId,
    lastGoodByChainId,
    lastGoodTsByChainId,
    bestByChainId,
    bestTsByChainId,
    bestMsByChainId,
  }
  return inMemorySettings
}

function saveRpcSettings(next: RpcSettings) {
  inMemorySettings = next
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(next))
}

export function setGlobalRpcProvider(provider: RpcProvider) {
  const cur = getRpcSettings()
  saveRpcSettings({ ...cur, provider })
}

export function getGlobalRpcProvider(): RpcProvider {
  return getRpcSettings().provider
}

export function getCustomRpcUrl(chainId: number): string {
  const cur = getRpcSettings()
  return cur.customByChainId[String(chainId)] ?? ''
}

export function setCustomRpcUrl(chainId: number, url: string) {
  const cur = getRpcSettings()
  const next = { ...cur.customByChainId }
  const cleaned = sanitizeCustomRpcUrl(url)
  if (cleaned) next[String(chainId)] = cleaned
  else delete next[String(chainId)]
  saveRpcSettings({ ...cur, customByChainId: next })
}

function getCachedBest(chainId: number): string | null {
  const cur = getRpcSettings()
  const k = String(chainId)
  const url = cur.bestByChainId[k]
  const ts = cur.bestTsByChainId[k]
  if (!url || typeof ts !== 'number') return null
  if ((Date.now() - ts) > BEST_RPC_CACHE_TTL) return null
  return url
}

function invalidateCachedBest(chainId: number) {
  const cur = getRpcSettings()
  const k = String(chainId)
  const { [k]: _url, ...restBest } = cur.bestByChainId
  const { [k]: _ts, ...restTs } = cur.bestTsByChainId
  const { [k]: _ms, ...restMs } = cur.bestMsByChainId
  saveRpcSettings({ ...cur, bestByChainId: restBest, bestTsByChainId: restTs, bestMsByChainId: restMs })
}

function getValidLastGood(chainId: number): string | null {
  const cur = getRpcSettings()
  const k = String(chainId)
  const url = cur.lastGoodByChainId[k]
  const ts = cur.lastGoodTsByChainId[k]
  if (!url) return null
  if (typeof ts === 'number' && (Date.now() - ts) > LAST_GOOD_TTL) return null
  return url
}

function setCachedBest(chainId: number, url: string, ms: number) {
  const cur = getRpcSettings()
  const k = String(chainId)
  saveRpcSettings({
    ...cur,
    bestByChainId: { ...cur.bestByChainId, [k]: url },
    bestTsByChainId: { ...cur.bestTsByChainId, [k]: Date.now() },
    bestMsByChainId: { ...cur.bestMsByChainId, [k]: ms },
  })

  // Notify UI (browser only) so it can update labels.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('whichway:rpc-best', { detail: { chainId, url, ms } }),
      )
    } catch {
      // ignore
    }
  }
}

function getCachedBestRpcInfo(chainId: number): { url: string; ms: number; ts: number } | null {
  const cur = getRpcSettings()
  const k = String(chainId)
  const url = cur.bestByChainId[k]
  const ts = cur.bestTsByChainId[k]
  const ms = cur.bestMsByChainId[k]
  if (!url || typeof ts !== 'number' || typeof ms !== 'number') return null
  if ((Date.now() - ts) > BEST_RPC_CACHE_TTL) return null
  return { url, ms, ts }
}

async function probeRpcUrl(url: string, expectedChainId: number): Promise<number> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BEST_RPC_PROBE_TIMEOUT_MS)

  const start = performance.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { result?: string; error?: { message?: string } }
    if (json.error) throw new Error(json.error.message ?? 'RPC error')
    if (!json.result) throw new Error('Missing chainId')

    const got = Number.parseInt(json.result, 16)
    if (!Number.isFinite(got) || got !== expectedChainId) throw new Error('Wrong chainId')

    return performance.now() - start
  } finally {
    clearTimeout(timeout)
  }
}

async function pickBestRpcUrl(chainId: number, urls: string[], force = false): Promise<string | null> {
  if (!force) {
    const cached = getCachedBest(chainId)
    if (cached) return cached
  }

  const candidates = urls.slice(0, BEST_RPC_PROBE_MAX)
  if (candidates.length === 0) return null

  const results = await Promise.allSettled(candidates.map(async (u) => ({ url: u, ms: await probeRpcUrl(u, chainId) })))
  let best: { url: string; ms: number } | null = null
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    if (!best || r.value.ms < best.ms) best = r.value
  }

  if (!best) return null
  setCachedBest(chainId, best.url, best.ms)
  return best.url
}

function providerLatencyKey(chainId: number, provider: RpcProvider): string {
  return `${provider}:${chainId}`
}

function getCachedProviderLatency(chainId: number, provider: RpcProvider): number | null | undefined {
  const k = providerLatencyKey(chainId, provider)
  const v = inMemoryProviderLatency[k]
  if (!v) return undefined
  if ((Date.now() - v.ts) > PROVIDER_LATENCY_CACHE_TTL) return undefined
  return v.ms
}

function setCachedProviderLatency(chainId: number, provider: RpcProvider, ms: number | null) {
  const k = providerLatencyKey(chainId, provider)
  inMemoryProviderLatency = { ...inMemoryProviderLatency, [k]: { ts: Date.now(), ms } }
}

async function pickFastestMs(chainId: number, urls: string[]): Promise<number | null> {
  const candidates = urls.filter(Boolean).slice(0, BEST_RPC_PROBE_MAX)
  if (candidates.length === 0) return null
  const results = await Promise.allSettled(candidates.map(async (u) => ({ url: u, ms: await probeRpcUrl(u, chainId) })))
  let best: number | null = null
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    if (best === null || r.value.ms < best) best = r.value.ms
  }
  return best
}

export async function primeRpcProviderLatency(
  chainId: number,
  provider: RpcProvider,
  opts: { force?: boolean } = {},
): Promise<number | null> {
  const force = !!opts.force
  if (!force) {
    const cached = getCachedProviderLatency(chainId, provider)
    if (cached !== undefined) return cached
  }

  const defaultUrl = getDefaultRpcUrl(chainId)
  const publicnode = PUBLICNODE_BY_CHAIN[chainId]

  if (provider === 'default') {
    const ms = await pickFastestMs(chainId, uniq([publicnode ?? '', defaultUrl ?? '']))
    setCachedProviderLatency(chainId, provider, ms)
    return ms
  }

  const chainlistUrls = await getChainlistRpcUrls(chainId)

  if (provider === 'chainlist') {
    // Use the same candidate set as the runtime auto mode.
    const candidates = uniq([
      ...(publicnode ? [publicnode] : []),
      ...chainlistUrls,
      ...(defaultUrl ? [defaultUrl] : []),
    ])
    const best = await pickBestRpcUrl(chainId, candidates, force)
    const info = getCachedBestRpcInfo(chainId)
    const ms = best && info ? info.ms : null
    setCachedProviderLatency(chainId, provider, ms)
    return ms
  }

  // drpc / llamarpc: just probe the matching subset from chainlist data.
  const providerUrls = pickProviderUrls(provider, chainlistUrls)
  const ms = await pickFastestMs(chainId, providerUrls)
  setCachedProviderLatency(chainId, provider, ms)
  return ms
}

function getDefaultRpcUrl(chainId: number): string | null {
  return chainById.get(chainId)?.rpcUrl ?? null
}

/** Domains known to reject browser CORS or return invalid headers. */
const CORS_BLOCKED_HOSTS = new Set([
  'rpc.hyperlend.finance',
  'hyperliquid.rpc.blxrbdn.com',
  'rpc.countzero.xyz',
])

function filterRpcUrls(urls: string[]): string[] {
  // chainlist often includes placeholders like ${INFURA_API_KEY}
  return urls
    .map(normalizeUrl)
    .filter(u => u.startsWith('https://'))
    .filter(u => !u.includes('${') && !u.includes('YOUR') && !u.includes('<') && !u.includes('API_KEY'))
    .filter(u => {
      try { return !CORS_BLOCKED_HOSTS.has(new URL(u).hostname) } catch { return false }
    })
}

function extractRpcUrls(rpc: unknown): string[] {
  if (!Array.isArray(rpc)) return []
  const urls: string[] = []
  for (const entry of rpc) {
    if (typeof entry === 'string') urls.push(entry)
    else if (entry && typeof entry === 'object' && 'url' in entry) {
      const maybeUrl = (entry as { url?: unknown }).url
      if (typeof maybeUrl === 'string') urls.push(maybeUrl)
    }
  }
  return urls
}

async function loadChainlistCache(): Promise<ChainlistCache> {
  if (inMemoryChainlist) return inMemoryChainlist

  const cached = safeJsonParse<ChainlistCache>(localStorage.getItem(KEY_CHAINLIST_CACHE))
  if (cached && typeof cached.ts === 'number' && cached.byChainId && (Date.now() - cached.ts) < CHAINLIST_CACHE_TTL) {
    inMemoryChainlist = cached
    return cached
  }

  // Prefer Chainlist's RPC dataset; fallback to chainid.network if unavailable.
  let data: Array<{ chainId: number; rpc?: unknown }> = []
  try {
    const res = await fetch('https://chainlist.org/rpcs.json')
    if (!res.ok) throw new Error(`Failed to fetch rpcs.json (${res.status})`)
    data = (await res.json()) as Array<{ chainId: number; rpc?: unknown }>
  } catch {
    try {
      const res = await fetch('https://chainid.network/chains.json')
      if (!res.ok) throw new Error(`Failed to fetch chains.json (${res.status})`)
      data = (await res.json()) as Array<{ chainId: number; rpc?: unknown }>
    } catch {
      // Both sources failed — use static fallback for supported chains
      inMemoryChainlist = STATIC_FALLBACK_CACHE
      return STATIC_FALLBACK_CACHE
    }
  }

  const byChainId: Record<string, string[]> = {}
  for (const c of data) {
    if (!c || typeof c.chainId !== 'number') continue
    const urls = extractRpcUrls(c.rpc)
    if (urls.length === 0) continue
    byChainId[String(c.chainId)] = filterRpcUrls(urls)
  }

  const next: ChainlistCache = { ts: Date.now(), byChainId }
  inMemoryChainlist = next
  localStorage.setItem(KEY_CHAINLIST_CACHE, JSON.stringify(next))
  return next
}

async function getChainlistRpcUrls(chainId: number): Promise<string[]> {
  try {
    const cache = await loadChainlistCache()
    return cache.byChainId[String(chainId)] ?? []
  } catch {
    return []
  }
}

function pickProviderUrls(provider: RpcProvider, chainlistUrls: string[]): string[] {
  if (provider === 'chainlist') return chainlistUrls

  if (provider === 'llamarpc') {
    return chainlistUrls.filter(u => u.toLowerCase().includes('llamarpc'))
  }

  if (provider === 'drpc') {
    return chainlistUrls.filter(u => u.toLowerCase().includes('drpc'))
  }

  return []
}

export async function getRpcCandidates(chainId: number): Promise<string[]> {
  const settings = getRpcSettings()
  const custom = settings.customByChainId[String(chainId)]
    ? sanitizeCustomRpcUrl(settings.customByChainId[String(chainId)])
    : null
  const lastGood = getValidLastGood(chainId)

  const defaultUrl = getDefaultRpcUrl(chainId)
  const chainlistUrls = await getChainlistRpcUrls(chainId)

  const publicnode = PUBLICNODE_BY_CHAIN[chainId]

  const providerUrls = settings.provider === 'default'
    ? []
    : pickProviderUrls(settings.provider, chainlistUrls)

  const candidates = uniq([
    ...(custom ? [custom] : []),
    ...(lastGood ? [lastGood] : []),
    ...(publicnode ? [publicnode] : []),
    ...providerUrls,
    ...(defaultUrl ? [defaultUrl] : []),
  ])

  return candidates
}

export async function rpcRequest<T = unknown>(
  chainId: number,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  let candidates = await getRpcCandidates(chainId)
  if (candidates.length === 0) throw new Error(`No RPC candidates for chain ${chainId}`)

  const settings = getRpcSettings()
  const custom = settings.customByChainId[String(chainId)]
  if (!custom && settings.provider === 'chainlist' && candidates.length > 1) {
    // P0: Non-blocking probe — use cached best or lastGood immediately,
    // only block if neither exists
    const cachedBest = getCachedBest(chainId)
    if (cachedBest) {
      candidates = [cachedBest, ...candidates.filter(u => u !== cachedBest)]
    } else {
      // Cache expired — try lastGood instantly, re-probe in background
      const lastGood = getValidLastGood(chainId)
      if (lastGood) {
        candidates = [lastGood, ...candidates.filter(u => u !== lastGood)]
        // Fire background re-probe (deduped)
        const probeKey = String(chainId)
        if (!backgroundProbeInFlight[probeKey]) {
          backgroundProbeInFlight[probeKey] = true
          void pickBestRpcUrl(chainId, candidates, true).finally(() => {
            backgroundProbeInFlight[probeKey] = false
          })
        }
      } else {
        // No cached best, no lastGood — block on probe
        const best = await pickBestRpcUrl(chainId, candidates)
        if (best) {
          candidates = [best, ...candidates.filter(u => u !== best)]
        }
      }
    }
  }

  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  let lastErr: unknown = null

  for (const url of candidates) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), RPC_REQUEST_TIMEOUT_MS)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(json.error.message ?? 'RPC error')
      if (json.result === undefined) throw new Error('Missing RPC result')

      // Success — reset failures, persist last-good with timestamp
      delete failCounts[url]
      const cur = getRpcSettings()
      saveRpcSettings({
        ...cur,
        lastGoodByChainId: { ...cur.lastGoodByChainId, [String(chainId)]: url },
        lastGoodTsByChainId: { ...cur.lastGoodTsByChainId, [String(chainId)]: Date.now() },
      })

      return json.result
    } catch (err) {
      // P1: Track consecutive failures per URL
      failCounts[url] = (failCounts[url] ?? 0) + 1
      if (failCounts[url] >= FAIL_THRESHOLD) {
        // Demote: if this was the cached best, invalidate so next call re-probes
        const cachedBest = getCachedBest(chainId)
        if (cachedBest === url) invalidateCachedBest(chainId)
        // Clear lastGood if it points to this dead URL
        const cur = getRpcSettings()
        if (cur.lastGoodByChainId[String(chainId)] === url) {
          const { [String(chainId)]: _, ...rest } = cur.lastGoodByChainId
          const { [String(chainId)]: _ts, ...restTs } = cur.lastGoodTsByChainId
          saveRpcSettings({ ...cur, lastGoodByChainId: rest, lastGoodTsByChainId: restTs })
        }
      }
      lastErr = err
      continue
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`RPC request failed for chain ${chainId}`)
}
