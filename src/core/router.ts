import type { BridgeInput, Route, RouteComparison } from './types'
import { compareForCheapestSort } from './quote'
import { isCCTPSupported, isUSDT0Supported } from '../config/chains'
import { getTokenAddress, NATIVE } from '../config/tokens'

type AcrossModule = typeof import('../providers/across')
type CctpModule = typeof import('../providers/cctp')
type Usdt0Module = typeof import('../providers/usdt0')
type RelayModule = typeof import('../providers/relay')
type GasZipModule = typeof import('../providers/gaszip')
type StargateModule = typeof import('../providers/stargate')
type CbridgeModule = typeof import('../providers/cbridge')
type DebridgeModule = typeof import('../providers/debridge')
type EcoModule = typeof import('../providers/eco')
type SynapseModule = typeof import('../providers/synapse')
type OrbiterModule = typeof import('../providers/orbiter')
type MayanModule = typeof import('../providers/mayan')

function createModuleLoader<T>(importer: () => Promise<T>): { load: () => Promise<T>; get: () => T | null } {
  let loaded: T | null = null
  let loading: Promise<T> | null = null
  return {
    load: () => {
      if (!loading) {
        loading = importer().then((module) => {
          loaded = module
          return module
        })
      }
      return loading
    },
    get: () => loaded,
  }
}

const acrossLoader = createModuleLoader<AcrossModule>(() => import('../providers/across'))
const cctpLoader = createModuleLoader<CctpModule>(() => import('../providers/cctp'))
const usdt0Loader = createModuleLoader<Usdt0Module>(() => import('../providers/usdt0'))
const relayLoader = createModuleLoader<RelayModule>(() => import('../providers/relay'))
const gaszipLoader = createModuleLoader<GasZipModule>(() => import('../providers/gaszip'))
const stargateLoader = createModuleLoader<StargateModule>(() => import('../providers/stargate'))
const cbridgeLoader = createModuleLoader<CbridgeModule>(() => import('../providers/cbridge'))
const debridgeLoader = createModuleLoader<DebridgeModule>(() => import('../providers/debridge'))
const ecoLoader = createModuleLoader<EcoModule>(() => import('../providers/eco'))
const synapseLoader = createModuleLoader<SynapseModule>(() => import('../providers/synapse'))
const orbiterLoader = createModuleLoader<OrbiterModule>(() => import('../providers/orbiter'))
const mayanLoader = createModuleLoader<MayanModule>(() => import('../providers/mayan'))

let didScheduleProviderPrefetch = false

export function prefetchQuoteProviders(): void {
  if (didScheduleProviderPrefetch) return
  didScheduleProviderPrefetch = true

  const runPrefetch = () => {
    void Promise.allSettled([
      cctpLoader.load(),
      usdt0Loader.load(),
      acrossLoader.load(),
      relayLoader.load(),
      stargateLoader.load(),
      cbridgeLoader.load(),
      gaszipLoader.load(),
      debridgeLoader.load(),
      ecoLoader.load(),
      synapseLoader.load(),
      orbiterLoader.load(),
      mayanLoader.load(),
    ])
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(runPrefetch)
    return
  }

  setTimeout(runPrefetch, 0)
}

/** Per-provider timeout — drops slow quotes instead of blocking results */
const PROVIDER_TIMEOUT_MS = 3_000

export function anyProviderSupportsRoute(tokenSymbol: string, fromChainId: number, toChainId: number): boolean {
  prefetchQuoteProviders()

  if (fromChainId === toChainId) return false

  // USDT0 routes go exclusively through the USDT0 OFT bridge
  if (tokenSymbol === 'USDT0') {
    return isUSDT0Supported(fromChainId) && isUSDT0Supported(toChainId)
  }

  const tokenAddressFrom = getTokenAddress(tokenSymbol, fromChainId)
  const tokenAddressTo = getTokenAddress(tokenSymbol, toChainId)

  // CCTP
  if (tokenSymbol === 'USDC' && isCCTPSupported(fromChainId) && isCCTPSupported(toChainId)) return true

  // USDT0 provider also handles USDT routes when local token matches a USDT0 deployment
  if (tokenSymbol === 'USDT' && isUSDT0Supported(fromChainId) && isUSDT0Supported(toChainId)) return true

  const across = acrossLoader.get()
  const relay = relayLoader.get()
  const stargate = stargateLoader.get()
  const cbridge = cbridgeLoader.get()
  const debridge = debridgeLoader.get()
  const eco = ecoLoader.get()
  const synapse = synapseLoader.get()
  const orbiter = orbiterLoader.get()
  const mayan = mayanLoader.get()

  let usedLoadedSupportCheck = false

  // Stargate Taxi/Bus / cBridge / deBridge / Synapse / Orbiter require token on both sides.
  if (tokenAddressFrom && tokenAddressTo) {
    if (stargate) {
      usedLoadedSupportCheck = true
      if (stargate.isStargateSupported(tokenSymbol, fromChainId, toChainId)) return true
    }
    if (cbridge) {
      usedLoadedSupportCheck = true
      if (cbridge.isCbridgeSupported(tokenSymbol, fromChainId, toChainId)) return true
    }
    if (debridge) {
      usedLoadedSupportCheck = true
      if (debridge.isDebridgeSupported(tokenSymbol, fromChainId, toChainId)) return true
    }
    if (synapse) {
      usedLoadedSupportCheck = true
      if (synapse.isSynapseSupported(fromChainId, toChainId, tokenSymbol)) return true
    }
    if (orbiter) {
      usedLoadedSupportCheck = true
      if (orbiter.isOrbiterSupported(fromChainId, toChainId)) return true
    }
  }

  // Across / Relay (API-driven) — local proof is token presence + known special cases
  if (across) {
    usedLoadedSupportCheck = true
    if (across.isAcrossSupported(tokenSymbol, fromChainId, toChainId)) return true
  }
  if (relay) {
    usedLoadedSupportCheck = true
    if (relay.isRelaySupported(tokenSymbol, fromChainId, toChainId)) return true
  }

  // Eco
  if (eco) {
    usedLoadedSupportCheck = true
    if (eco.isEcoSupported(tokenSymbol, fromChainId, toChainId)) return true
  }

  // Mayan
  if (mayan) {
    usedLoadedSupportCheck = true
    if (mayan.isMayanSupported(tokenSymbol, fromChainId, toChainId)) return true
  }

  // Gas.zip (native ETH only)
  if (tokenSymbol === 'ETH') {
    const fromIsNative = tokenAddressFrom?.toLowerCase() === NATIVE.toLowerCase()
    const toIsNative = tokenAddressTo?.toLowerCase() === NATIVE.toLowerCase()
    if (fromIsNative && toIsNative) return true
  }

  // Before loaders resolve, keep UX permissive so destination options don't disappear.
  if (!usedLoadedSupportCheck && tokenAddressFrom && tokenAddressTo) {
    return true
  }

  return false
}

function abortError(reason: 'abort' | 'timeout'): DOMException {
  return new DOMException(reason === 'timeout' ? 'Timed out' : 'Aborted', reason === 'timeout' ? 'TimeoutError' : 'AbortError')
}

/**
 * Run an async quote function with:
 * - a hard timeout (aborts the signal so fetch() actually cancels)
 * - optional parent AbortSignal propagation
 */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()

  const onParentAbort = () => controller.abort(parentSignal?.reason ?? abortError('abort'))
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason ?? abortError('abort'))
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }
  }

  const timeoutId = setTimeout(() => controller.abort(abortError('timeout')), ms)

  return fn(controller.signal).finally(() => {
    clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', onParentAbort)
  })
}

export async function getRoutes(
  input: BridgeInput,
  signal?: AbortSignal,
  onRoute?: (route: Route) => void,
  providerFilter?: string,
): Promise<RouteComparison> {
  const { amount, token, fromChain, toChain, userAddress } = input
  const recipient = input.recipient
  const routes: Route[] = []
  const promises: Promise<Route | null>[] = []

  const tokenAddress = getTokenAddress(token.symbol, fromChain.id)
  const tokenAddressTo = getTokenAddress(token.symbol, toChain.id)

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  const shouldQuery = (name: string) => !providerFilter || providerFilter === name

  const isUSDT0Token = token.symbol === 'USDT0'

  const quoteParams = { token: token.symbol, amount, fromChainId: fromChain.id, toChainId: toChain.id, userAddress, recipient }
  const timedQuote = (fn: (s: AbortSignal) => Promise<Route | null>): Promise<Route | null> =>
    withTimeout(fn, PROVIDER_TIMEOUT_MS, signal).catch(() => null)

  const loadersToWarm: Array<Promise<unknown>> = []
  if ((shouldQuery('cctp') || shouldQuery('cctp-slow')) && token.symbol === 'USDC' && isCCTPSupported(fromChain.id) && isCCTPSupported(toChain.id)) {
    loadersToWarm.push(cctpLoader.load())
  }
  if (shouldQuery('usdt0') && (token.symbol === 'USDT' || isUSDT0Token) && isUSDT0Supported(fromChain.id) && isUSDT0Supported(toChain.id)) {
    loadersToWarm.push(usdt0Loader.load())
  }
  if (tokenAddress && !isUSDT0Token) {
    if (shouldQuery('across')) loadersToWarm.push(acrossLoader.load())
    if (shouldQuery('relay')) loadersToWarm.push(relayLoader.load())
  }
  if (tokenAddress && tokenAddressTo && !isUSDT0Token) {
    if (shouldQuery('stargate-taxi') || shouldQuery('stargate-bus')) loadersToWarm.push(stargateLoader.load())
    if (shouldQuery('cbridge')) loadersToWarm.push(cbridgeLoader.load())
    if (shouldQuery('debridge')) loadersToWarm.push(debridgeLoader.load())
    if (shouldQuery('synapse')) loadersToWarm.push(synapseLoader.load())
    if (shouldQuery('orbiter')) loadersToWarm.push(orbiterLoader.load())
    if (shouldQuery('mayan-swift') || shouldQuery('mayan-mctp') || shouldQuery('mayan-wh')) loadersToWarm.push(mayanLoader.load())
  }
  if (shouldQuery('eco') && !isUSDT0Token) {
    loadersToWarm.push(ecoLoader.load())
  }
  if (shouldQuery('gaszip') && token.symbol === 'ETH'
    && tokenAddress?.toLowerCase() === NATIVE.toLowerCase()
    && tokenAddressTo?.toLowerCase() === NATIVE.toLowerCase()) {
    loadersToWarm.push(gaszipLoader.load())
  }

  if (loadersToWarm.length) {
    await Promise.all(loadersToWarm)
  }

  const cctp = cctpLoader.get()
  const usdt0 = usdt0Loader.get()
  const across = acrossLoader.get()
  const relay = relayLoader.get()
  const stargate = stargateLoader.get()
  const cbridge = cbridgeLoader.get()
  const gaszip = gaszipLoader.get()
  const debridge = debridgeLoader.get()
  const eco = ecoLoader.get()
  const synapse = synapseLoader.get()
  const orbiter = orbiterLoader.get()
  const mayan = mayanLoader.get()

  if (cctp && token.symbol === 'USDC' && isCCTPSupported(fromChain.id) && isCCTPSupported(toChain.id)) {
    if (shouldQuery('cctp')) {
      promises.push(
        timedQuote((s) => cctp.getCCTPQuote({ amount, fromChainId: fromChain.id, toChainId: toChain.id, userAddress, recipient }, s)),
      )
    }
    if (shouldQuery('cctp-slow')) {
      promises.push(
        timedQuote((s) => cctp.getCCTPSlowQuote({ amount, fromChainId: fromChain.id, toChainId: toChain.id, userAddress, recipient }, s)),
      )
    }
  }

  if (shouldQuery('usdt0') && usdt0 && (token.symbol === 'USDT' || isUSDT0Token) && isUSDT0Supported(fromChain.id) && isUSDT0Supported(toChain.id)) {
    promises.push(
      timedQuote((s) => usdt0.getUSDT0Quote({ amount, fromChainId: fromChain.id, toChainId: toChain.id, userAddress, recipient, tokenSymbol: token.symbol }, s)),
    )
  }

  // USDT0 token routes exclusively through the USDT0 OFT provider — skip all traditional bridges.
  if (!isUSDT0Token && tokenAddress) {
    if (shouldQuery('across') && across) {
      promises.push(
        timedQuote((s) => across.isAcrossSupported(token.symbol, fromChain.id, toChain.id)
          ? across.getAcrossQuote(quoteParams, s)
          : Promise.resolve(null)),
      )
    }

    if (shouldQuery('relay') && relay) {
      promises.push(
        timedQuote((s) => relay.isRelaySupported(token.symbol, fromChain.id, toChain.id)
          ? relay.getRelayQuote(quoteParams, s)
          : Promise.resolve(null)),
      )
    }
  }

  // Stargate Taxi/Bus (Stargate V2) — same-asset liquidity pool bridging (taxi = fast, bus = economy)
  if ((shouldQuery('stargate-taxi') || shouldQuery('stargate-bus')) && !isUSDT0Token && stargate && tokenAddress && tokenAddressTo && stargate.isStargateSupported(token.symbol, fromChain.id, toChain.id)) {
    const sgPromise = withTimeout(
      (s) => stargate.getStargateQuotes(quoteParams, s),
      PROVIDER_TIMEOUT_MS,
      signal,
    ).catch(() => [null, null] as [Route | null, Route | null])
    promises.push(sgPromise.then(([taxi]) => taxi))
    promises.push(sgPromise.then(([, bus]) => bus))
  }

  if (shouldQuery('cbridge') && !isUSDT0Token && cbridge && tokenAddress && tokenAddressTo && cbridge.isCbridgeSupported(token.symbol, fromChain.id, toChain.id)) {
    promises.push(timedQuote((s) => cbridge.getCbridgeQuote(quoteParams, s)))
  }

  // Gas.zip — native gas token bridging only (ETH on chains where ETH is the native currency)
  // Skip chains where ETH is wrapped (e.g. Polygon WETH, BNB chain)
  if (shouldQuery('gaszip') && gaszip && token.symbol === 'ETH'
    && tokenAddress?.toLowerCase() === NATIVE.toLowerCase()
    && tokenAddressTo?.toLowerCase() === NATIVE.toLowerCase()) {
    promises.push(
      timedQuote((s) => gaszip.getGasZipQuote({ amount, fromChainId: fromChain.id, toChainId: toChain.id, userAddress, recipient }, s)),
    )
  }

  if (shouldQuery('debridge') && !isUSDT0Token && debridge && tokenAddress && tokenAddressTo && debridge.isDebridgeSupported(token.symbol, fromChain.id, toChain.id)) {
    promises.push(timedQuote((s) => debridge.getDebridgeQuote(quoteParams, s)))
  }

  // Eco Routes — stablecoin-only intent bridge
  if (shouldQuery('eco') && !isUSDT0Token && eco && eco.isEcoSupported(token.symbol, fromChain.id, toChain.id)) {
    promises.push(timedQuote((s) => eco.getEcoQuote(quoteParams, s)))
  }

  if (shouldQuery('synapse') && !isUSDT0Token && synapse && tokenAddress && tokenAddressTo && synapse.isSynapseSupported(fromChain.id, toChain.id, token.symbol)) {
    promises.push(timedQuote((s) => synapse.getSynapseQuote(quoteParams, s)))
  }

  if (shouldQuery('orbiter') && !isUSDT0Token && orbiter && tokenAddress && tokenAddressTo && orbiter.isOrbiterSupported(fromChain.id, toChain.id)) {
    promises.push(timedQuote((s) => orbiter.getOrbiterQuote(quoteParams, s)))
  }

  // Mayan — intent-based bridge via Swift/MCTP/Wormhole (returns up to 3 routes)
  if ((shouldQuery('mayan-swift') || shouldQuery('mayan-mctp') || shouldQuery('mayan-wh')) && !isUSDT0Token && mayan && mayan.isMayanSupported(token.symbol, fromChain.id, toChain.id)) {
    const mayanPromise = withTimeout(
      (s) => mayan.getMayanQuotes(quoteParams, s),
      PROVIDER_TIMEOUT_MS,
      signal,
    ).catch(() => [] as (Route | null)[])
    // Spread into individual promises for each type (Swift, MCTP, WH)
    promises.push(mayanPromise.then(routes => routes[0] ?? null))
    promises.push(mayanPromise.then(routes => routes[1] ?? null))
    promises.push(mayanPromise.then(routes => routes[2] ?? null))
  }

  // Stream each route to caller as it resolves (but never after abort)
  const streamed = onRoute
    ? promises.map((p) => p.then((route) => {
        if (route && !signal?.aborted) onRoute(route)
        return route
      }))
    : promises

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    : null

  const settled = abortPromise
    ? await Promise.race([Promise.allSettled(streamed), abortPromise])
    : await Promise.allSettled(streamed)

  const results = settled as PromiseSettledResult<Route | null>[]
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) routes.push(r.value)
  }

  if (routes.length === 0) return { fastest: null, cheapest: null, allRoutes: [] }

  const { fastest, cheapest } = selectFastestAndCheapest(routes)
  return { fastest, cheapest, allRoutes: routes }
}

export function selectFastestAndCheapest(routes: Route[]): { fastest: Route | null; cheapest: Route | null } {
  if (!routes.length) return { fastest: null, cheapest: null }

  // Grace window: if two routes are within 1s, prefer higher economic output
  const FASTEST_TIME_GRACE_SEC = 1
  const fastest = routes.reduce((a, b) => {
    const timeDiff = Math.abs(a.estimatedTime - b.estimatedTime)
    if (timeDiff <= FASTEST_TIME_GRACE_SEC) {
      return a.amountReceivedUSD >= b.amountReceivedUSD ? a : b
    }
    return a.estimatedTime < b.estimatedTime ? a : b
  })

  const cheapest = routes.reduce((a, b) => {
    return compareForCheapestSort(a, b) <= 0 ? a : b
  })

  return { fastest, cheapest }
}
