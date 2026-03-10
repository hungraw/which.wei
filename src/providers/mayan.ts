import { z } from 'zod/v4'
import { encodeFunctionData } from 'viem'
import { quoteParamsMatch, type Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenAddress, getTokenDecimals, NATIVE, STABLECOINS, ZERO_BYTES32 } from '../config/tokens'
import { waitForRateLimit } from '../utils/rate-limit'
import { estimateGasCostUSDSafe, GAS_ERC20_APPROVE, GAS_MAYAN_FORWARD } from '../utils/gas'
import { getNativeTokenPriceUSD } from '../utils/prices'
import { isAbortError } from '../utils/errors'
import { tagCalldata } from '../config/providers'
import { CHAIN_ID } from '../config/chains'
import { effectiveRecipient } from '../utils/recipient'

const MAYAN_QUOTE_API = 'https://price-api.mayan.finance/v3/quote'

/** Required by Mayan's backend to produce valid quotes. From official SDK addresses. */
const MAYAN_PROGRAM_ID = 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf'
const MAYAN_FORWARDER = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2'

/**
 * Map our chain IDs → Mayan's chain name parameter.
 * Mayan does NOT support Ink (57073).
 */
const MAYAN_CHAIN_NAMES: Record<number, string> = {
  [CHAIN_ID.ETHEREUM]: 'ethereum',
  [CHAIN_ID.BASE]:     'base',
  [CHAIN_ID.ARBITRUM]: 'arbitrum',
  [CHAIN_ID.OPTIMISM]: 'optimism',
  [CHAIN_ID.POLYGON]:  'polygon',
  [CHAIN_ID.BSC]:      'bsc',
  [CHAIN_ID.HYPEREVM]: 'hyperevm',
}

const CCTP_TOKEN_DECIMALS = 6

/** Wormhole chain IDs for our supported EVM chains */
const WORMHOLE_CHAIN_IDS: Record<number, number> = {
  [CHAIN_ID.ETHEREUM]: 2,
  [CHAIN_ID.BSC]: 4,
  [CHAIN_ID.POLYGON]: 5,
  [CHAIN_ID.OPTIMISM]: 24,
  [CHAIN_ID.ARBITRUM]: 23,
  [CHAIN_ID.BASE]: 30,
}

/** CCTP v2 domains (used by MCTP / FAST_MCTP quote types) */
const CCTP_DOMAINS: Record<string, number> = {
  ethereum: 0,
  optimism: 2,
  arbitrum: 3,
  base: 6,
  polygon: 7,
}

function padBytes32(addr: string): `0x${string}` {
  return ('0x' + addr.slice(2).toLowerCase().padStart(64, '0')) as `0x${string}`
}

function toFractional(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * (10 ** decimals)))
}

/** Generate 32-byte random key from quoteId (matches SDK's createSwiftRandomKey) */
function randomKeyFromQuoteId(quoteId?: string): `0x${string}` {
  if (quoteId) {
    const hex = quoteId.replace('0x', '').padEnd(64, '0').slice(0, 64)
    return ('0x' + hex) as `0x${string}`
  }
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}


const REFERRAL_BYTES32 = '0x0000000000000000000000001ad0616798839b9d691a7281ce912cd5c0212329' as `0x${string}`

// Empty ERC-2612 permit (we use explicit approve, so all fields are zero)
const EMPTY_PERMIT = {
  value: 0n,
  deadline: 0n,
  v: 0,
  r: ZERO_BYTES32,
  s: ZERO_BYTES32,
}

const MAYAN_FORWARDER_ABI = [
  {
    name: 'forwardERC20',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'permitParams', type: 'tuple', components: [
        { name: 'value', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'v', type: 'uint8' },
        { name: 'r', type: 'bytes32' },
        { name: 's', type: 'bytes32' },
      ]},
      { name: 'mayanProtocol', type: 'address' },
      { name: 'protocolData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'forwardEth',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'mayanProtocol', type: 'address' },
      { name: 'protocolData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const FAST_MCTP_ABI = [
  {
    name: 'bridge',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'redeemFee', type: 'uint64' },
      { name: 'circleMaxFee', type: 'uint256' },
      { name: 'gasDrop', type: 'uint64' },
      { name: 'destAddr', type: 'bytes32' },
      { name: 'destDomain', type: 'uint32' },
      { name: 'referrerAddress', type: 'bytes32' },
      { name: 'referrerBps', type: 'uint8' },
      { name: 'payloadType', type: 'uint8' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'customPayload', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'createOrder',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'circleMaxFee', type: 'uint256' },
      { name: 'destDomain', type: 'uint32' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'orderPayload', type: 'tuple', components: [
        { name: 'payloadType', type: 'uint8' },
        { name: 'destAddr', type: 'bytes32' },
        { name: 'tokenOut', type: 'bytes32' },
        { name: 'amountOutMin', type: 'uint64' },
        { name: 'gasDrop', type: 'uint64' },
        { name: 'redeemFee', type: 'uint64' },
        { name: 'refundFee', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'referrerAddr', type: 'bytes32' },
        { name: 'referrerBps', type: 'uint8' },
      ]},
    ],
    outputs: [],
  },
] as const

const SWIFT_V2_ABI = [
  {
    name: 'createOrderWithToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'params', type: 'tuple', components: [
        { name: 'payloadType', type: 'uint8' },
        { name: 'trader', type: 'bytes32' },
        { name: 'destAddr', type: 'bytes32' },
        { name: 'destChainId', type: 'uint16' },
        { name: 'referrerAddr', type: 'bytes32' },
        { name: 'tokenOut', type: 'bytes32' },
        { name: 'minAmountOut', type: 'uint64' },
        { name: 'gasDrop', type: 'uint64' },
        { name: 'cancelFee', type: 'uint64' },
        { name: 'refundFee', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'referrerBps', type: 'uint8' },
        { name: 'auctionMode', type: 'uint8' },
        { name: 'random', type: 'bytes32' },
      ]},
      { name: 'customPayload', type: 'bytes' },
    ],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
  },
  {
    name: 'createOrderWithEth',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'payloadType', type: 'uint8' },
        { name: 'trader', type: 'bytes32' },
        { name: 'destAddr', type: 'bytes32' },
        { name: 'destChainId', type: 'uint16' },
        { name: 'referrerAddr', type: 'bytes32' },
        { name: 'tokenOut', type: 'bytes32' },
        { name: 'minAmountOut', type: 'uint64' },
        { name: 'gasDrop', type: 'uint64' },
        { name: 'cancelFee', type: 'uint64' },
        { name: 'refundFee', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'referrerBps', type: 'uint8' },
        { name: 'auctionMode', type: 'uint8' },
        { name: 'random', type: 'bytes32' },
      ]},
      { name: 'customPayload', type: 'bytes' },
    ],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
  },
] as const

const MCTP_ABI = [
  {
    name: 'bridgeWithLockedFee',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'gasDrop', type: 'uint64' },
      { name: 'redeemFee', type: 'uint256' },
      { name: 'destDomain', type: 'uint32' },
      { name: 'destAddr', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'bridgeWithFee',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'redeemFee', type: 'uint64' },
      { name: 'gasDrop', type: 'uint64' },
      { name: 'destAddr', type: 'bytes32' },
      { name: 'destDomain', type: 'uint32' },
      { name: 'payloadType', type: 'uint8' },
      { name: 'customPayload', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'createOrder',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'gasDrop', type: 'uint64' },
        { name: 'destAddr', type: 'bytes32' },
        { name: 'destChain', type: 'uint16' },
        { name: 'tokenOut', type: 'bytes32' },
        { name: 'minAmountOut', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'redeemFee', type: 'uint64' },
        { name: 'referrerAddr', type: 'bytes32' },
        { name: 'referrerBps', type: 'uint8' },
      ]},
    ],
    outputs: [],
  },
] as const

const MayanQuoteItemSchema = z.object({
  type: z.string(),                          // 'SWIFT', 'MCTP', 'WH', etc.
  effectiveAmountIn: z.number(),
  expectedAmountOut: z.number(),
  minAmountOut: z.number(),
  price: z.number(),
  priceImpact: z.number().nullable(),
  swapRelayerFee: z.number().nullable().optional(),
  redeemRelayerFee: z.number().nullable().optional(),
  refundRelayerFee: z.number().nullable().optional(),
  eta: z.number(),                           // minutes (NOT seconds)
  etaSeconds: z.number().optional(),         // exact seconds (preferred)
  clientEta: z.string().optional(),          // human readable e.g. "1 min"
  fromToken: z.object({
    mint: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    contract: z.string(),
  }).passthrough(),
  toToken: z.object({
    mint: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    contract: z.string(),
  }).passthrough(),
  fromChain: z.string().optional(),
  toChain: z.string().optional(),
  fromAmount: z.number().optional(),
  deadline64: z.string().optional(),
  toPrice: z.number().optional(),            // price of output token in USD
  clientRelayerFeeSuccess: z.number().nullable().optional(), // total relayer fee in USD (success)
}).passthrough()

const MayanQuoteResponseSchema = z.object({
  quotes: z.array(MayanQuoteItemSchema),
}).passthrough()

type MayanQuoteItem = z.infer<typeof MayanQuoteItemSchema>

let lastQuote: { items: MayanQuoteItem[]; best: MayanQuoteItem } | null = null
let lastParams: MayanQuoteParams | null = null

/** Map API quote type → display name */
const MAYAN_TYPE_NAMES: Record<string, string> = {
  'SWIFT':     'Mayan Swift',
  'MCTP':      'Mayan MCTP',
  'FAST_MCTP': 'Mayan MCTP',   // grouped with MCTP — pick best of the two
  'WH':        'Mayan WH',
}

interface MayanQuoteParams {
  token: string      // symbol
  amount: string     // raw amount in smallest unit
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export function isMayanSupported(token: string, fromChainId: number, toChainId: number): boolean {
  // Both chains must be in Mayan's EVM set
  if (!MAYAN_CHAIN_NAMES[fromChainId] || !MAYAN_CHAIN_NAMES[toChainId]) return false
  // Token must exist on both chains
  const fromAddr = getTokenAddress(token, fromChainId)
  const toAddr = getTokenAddress(token, toChainId)
  return !!(fromAddr && toAddr)
}

export async function getMayanQuotes(params: MayanQuoteParams, signal?: AbortSignal): Promise<(Route | null)[]> {
  const { token, amount, fromChainId, toChainId } = params

  const fromChain = MAYAN_CHAIN_NAMES[fromChainId]
  const toChain = MAYAN_CHAIN_NAMES[toChainId]
  if (!fromChain || !toChain) return []

  const fromAddr = getTokenAddress(token, fromChainId)
  const toAddr = getTokenAddress(token, toChainId)
  if (!fromAddr || !toAddr) return []

  const decimals = getTokenDecimals(token, fromChainId) ?? 18

  // Mayan quote API uses human-readable amounts (e.g. "10" not "10000000")
  const humanAmount = Number(amount) / (10 ** decimals)
  if (humanAmount <= 0 || !isFinite(humanAmount)) return []

  // Use token contract address (NOT 0xEeee for native)
  // For native ETH, Mayan expects the zero address
  const mayanFromAddr = fromAddr.toLowerCase() === NATIVE.toLowerCase()
    ? '0x0000000000000000000000000000000000000000'
    : fromAddr
  const mayanToAddr = toAddr.toLowerCase() === NATIVE.toLowerCase()
    ? '0x0000000000000000000000000000000000000000'
    : toAddr

  const url = new URL(MAYAN_QUOTE_API)
  // Required SDK-level params — without these the API returns 500
  url.searchParams.set('solanaProgram', MAYAN_PROGRAM_ID)
  url.searchParams.set('forwarderAddress', MAYAN_FORWARDER)
  url.searchParams.set('swift', 'true')
  url.searchParams.set('mctp', 'true')
  url.searchParams.set('fastMctp', 'true')
  url.searchParams.set('wormhole', 'true')
  url.searchParams.set('sdkVersion', '12.2.5')
  // Route params
  url.searchParams.set('amountIn', String(humanAmount))
  url.searchParams.set('fromToken', mayanFromAddr)
  url.searchParams.set('fromChain', fromChain)
  url.searchParams.set('toToken', mayanToAddr)
  url.searchParams.set('toChain', toChain)
  url.searchParams.set('slippageBps', 'auto')
  url.searchParams.set('gasDrop', '0')

  try {
    await waitForRateLimit('mayan')
    const res = await fetch(url.toString(), { signal })

    if (!res.ok) return []

    const raw = await res.json()
    const parsed = MayanQuoteResponseSchema.parse(raw)
    const items = parsed.quotes

    if (items.length === 0) return []

    // Group by display name: SWIFT, MCTP (best of MCTP/FAST_MCTP), WH
    // For each group, pick the quote with the highest expectedAmountOut
    const groups: Record<string, MayanQuoteItem> = {}
    for (const q of items) {
      const displayName = MAYAN_TYPE_NAMES[q.type]
      if (!displayName) continue
      if (!groups[displayName] || q.expectedAmountOut > groups[displayName].expectedAmountOut) {
        groups[displayName] = q
      }
    }

    const best = Object.values(groups).reduce((a, b) =>
      a.expectedAmountOut >= b.expectedAmountOut ? a : b,
    )
    lastQuote = { items, best }
    lastParams = params

    const isNativeToken = fromAddr.toLowerCase() === NATIVE.toLowerCase()
    const gasUnits = isNativeToken ? GAS_MAYAN_FORWARD : GAS_MAYAN_FORWARD + GAS_ERC20_APPROVE
    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, gasUnits)

    // Build a route for each type group
    const routes: (Route | null)[] = []
    for (const [displayName, q] of Object.entries(groups)) {
      const outDecimals = getTokenDecimals(token, toChainId) ?? q.toToken.decimals
      const amountOutRaw = BigInt(Math.round(q.expectedAmountOut * (10 ** outDecimals)))
      const amountOutStr = amountOutRaw.toString()

      const feeHuman = Math.max(0, humanAmount - q.expectedAmountOut)
      const feeUSD = q.clientRelayerFeeSuccess
        ?? (STABLECOINS.has(token.toUpperCase()) ? feeHuman : feeHuman * q.price)

      const outputPrice = q.toPrice || q.price
      const receivedUSD = STABLECOINS.has(token.toUpperCase())
        ? q.expectedAmountOut
        : q.expectedAmountOut * outputPrice

      const estimatedTime = q.etaSeconds ?? (q.eta * 60)

      // MCTP routes have a Wormhole bridgeFee paid in native tokens (not deducted from output)
      let nativeFeeUSD: number | undefined
      if (q.type === 'MCTP' && typeof (q as Record<string, unknown>).bridgeFee === 'number') {
        const bridgeFeeEth = (q as Record<string, unknown>).bridgeFee as number
        if (bridgeFeeEth > 0) {
          const nativePrice = await getNativeTokenPriceUSD(fromChainId)
          nativeFeeUSD = nativePrice ? bridgeFeeEth * nativePrice : bridgeFeeEth * 2500
        }
      }

      routes.push(buildRoute({
        provider: displayName,
        fromToken: token,
        toToken: token,
        fromChainId,
        toChainId,
        amountIn: amount,
        amountOut: amountOutStr,
        gasCostUSD,
        feeUSD,
        nativeFeeUSD,
        estimatedTime,
        receivedUSD,
        providerData: { quote: q, allQuotes: items },
      }))
    }

    return routes
  } catch (err) {
    if (isAbortError(err)) return []
    console.warn('[mayan] quote failed:', err)
    return []
  }
}

/**
 * Build protocol-specific calldata for a Mayan quote, then wrap in a
 * MayanForwarder call. Returns a ready-to-send tx or null on failure.
 *
 * Supports FAST_MCTP, SWIFT (V2), and MCTP quote types.
 * All calldata is constructed locally — no external swap API needed.
 */
function buildMayanTx(
  quote: MayanQuoteItem,
  userAddress: string,
  fromChainId: number,
  toChainId: number,
  isNative: boolean,
  recipient: string,
): { to: `0x${string}`; data: `0x${string}`; value: string } | null {
  // Access passthrough fields from the quote API
  const q = quote as Record<string, unknown>

  const toChainName = MAYAN_CHAIN_NAMES[toChainId]
  const fromChainName = MAYAN_CHAIN_NAMES[fromChainId]
  if (!toChainName || !fromChainName) return null

  const destWormholeId = WORMHOLE_CHAIN_IDS[toChainId]
  const destAddr = padBytes32(recipient)
  const amountIn = BigInt((q.effectiveAmountIn64 as string) ?? '0')
  if (amountIn === 0n) return null

  let protocolData: `0x${string}` | null = null
  let protocolContract: string | null = null
  let extraValue = 0n // ETH needed beyond the bridge amount (e.g. Wormhole fees)

  const toTokenContract = quote.toToken.contract

  switch (quote.type) {
    case 'FAST_MCTP': {
      protocolContract = q.fastMctpMayanContract as string
      const tokenIn = q.fastMctpInputContract as string
      if (!protocolContract || !tokenIn) return null

      const destDomain = CCTP_DOMAINS[toChainName]
      if (destDomain === undefined) return null

      const redeemFee = toFractional(quote.redeemRelayerFee ?? 0, CCTP_TOKEN_DECIMALS)
      const circleMaxFee = BigInt((q.circleMaxFee64 as string) ?? '0')
      const gasDrop = toFractional((q.gasDrop as number) ?? 0, Math.min(18, 8))
      const minFinality = (q.fastMctpMinFinality as number) ?? 0

      if (q.hasAuction) {
        const tokenOut = padBytes32(toTokenContract)
        const minAmountOut = toFractional(quote.minAmountOut, Math.min(8, quote.toToken.decimals))
        const refundFee = BigInt((q.refundRelayerFee64 as string) ?? '0')
        const deadline = BigInt(q.deadline64 as string ?? '0')

        protocolData = encodeFunctionData({
          abi: FAST_MCTP_ABI,
          functionName: 'createOrder',
          args: [
            tokenIn as `0x${string}`, amountIn, circleMaxFee,
            destDomain, minFinality,
            {
              payloadType: 1,
              destAddr,
              tokenOut,
              amountOutMin: minAmountOut,
              gasDrop,
              redeemFee,
              refundFee,
              deadline,
              referrerAddr: REFERRAL_BYTES32,
              referrerBps: 0,
            },
          ],
        })
      } else {
        protocolData = encodeFunctionData({
          abi: FAST_MCTP_ABI,
          functionName: 'bridge',
          args: [
            tokenIn as `0x${string}`, amountIn,
            redeemFee, circleMaxFee, gasDrop,
            destAddr, destDomain,
            REFERRAL_BYTES32, 0,  // referrer
            1, minFinality,   // payloadType, minFinalityThreshold
            '0x',             // customPayload (empty)
          ],
        })
      }
      break
    }

    case 'SWIFT': {
      protocolContract = q.swiftMayanContract as string
      const tokenIn = q.swiftInputContract as string
      if (!protocolContract || !tokenIn) return null
      if (!destWormholeId) return null

      const normFactor = 8
      const tokenOut = toTokenContract === '0x0000000000000000000000000000000000000000'
        ? ZERO_BYTES32
        : padBytes32(toTokenContract)

      const minAmountOut = toFractional(quote.minAmountOut, Math.min(quote.toToken.decimals, normFactor))
      const gasDropAmt = toFractional((q.gasDrop as number) ?? 0, Math.min(18, normFactor))
      const cancelFee = BigInt((q.cancelRelayerFee64 as string) ?? '0')
      const refundFee = BigInt((q.refundRelayerFee64 as string) ?? '0')
      const deadline = BigInt(q.deadline64 as string ?? '0')
      const auctionMode = (q.swiftAuctionMode as number) ?? 0
      const random = randomKeyFromQuoteId(q.quoteId as string | undefined)

      const orderParams = {
        payloadType: 1,
        trader: padBytes32(userAddress),
        destAddr,
        destChainId: destWormholeId,
        referrerAddr: REFERRAL_BYTES32,
        tokenOut,
        minAmountOut,
        gasDrop: gasDropAmt,
        cancelFee,
        refundFee,
        deadline,
        referrerBps: 0,
        auctionMode,
        random,
      }

      if (isNative) {
        protocolData = encodeFunctionData({
          abi: SWIFT_V2_ABI,
          functionName: 'createOrderWithEth',
          args: [orderParams, '0x'],
        })
      } else {
        protocolData = encodeFunctionData({
          abi: SWIFT_V2_ABI,
          functionName: 'createOrderWithToken',
          args: [tokenIn as `0x${string}`, amountIn, orderParams, '0x'],
        })
      }
      break
    }

    case 'MCTP': {
      protocolContract = q.mctpMayanContract as string
      const tokenIn = q.mctpInputContract as string
      if (!protocolContract || !tokenIn) return null

      const destDomain = CCTP_DOMAINS[toChainName]
      if (destDomain === undefined) return null

      const redeemFee = toFractional(quote.redeemRelayerFee ?? 0, CCTP_TOKEN_DECIMALS)
      const gasDrop = toFractional((q.gasDrop as number) ?? 0, Math.min(18, 8))

      if (q.hasAuction) {
        if (!destWormholeId) return null
        const tokenOut = padBytes32(toTokenContract)
        const minAmountOut = toFractional(quote.minAmountOut, Math.min(8, quote.toToken.decimals))
        const deadline = BigInt(q.deadline64 as string ?? '0')
        const bridgeFee = toFractional((q.bridgeFee as number) ?? 0, 18)
        extraValue = bridgeFee

        protocolData = encodeFunctionData({
          abi: MCTP_ABI,
          functionName: 'createOrder',
          args: [{
            tokenIn: tokenIn as `0x${string}`,
            amountIn,
            gasDrop,
            destAddr,
            destChain: destWormholeId,
            tokenOut,
            minAmountOut,
            deadline,
            redeemFee,
            referrerAddr: REFERRAL_BYTES32,
            referrerBps: 0,
          }],
        })
      } else if ((q.cheaperChain as string) === fromChainName) {
        protocolData = encodeFunctionData({
          abi: MCTP_ABI,
          functionName: 'bridgeWithLockedFee',
          args: [
            tokenIn as `0x${string}`, amountIn,
            gasDrop, redeemFee,
            destDomain, destAddr,
          ],
        })
      } else {
        const bridgeFee = toFractional((q.bridgeFee as number) ?? 0, 18)
        extraValue = bridgeFee

        protocolData = encodeFunctionData({
          abi: MCTP_ABI,
          functionName: 'bridgeWithFee',
          args: [
            tokenIn as `0x${string}`, amountIn,
            redeemFee, gasDrop,
            destAddr, destDomain,
            1,    // payloadType
            '0x', // customPayload
          ],
        })
      }
      break
    }

    default:
      console.warn('[mayan] unsupported quote type for execution:', quote.type)
      return null
  }

  if (!protocolData || !protocolContract) return null

  // Outer layer: wrap protocol calldata in a MayanForwarder call
  let data: `0x${string}`
  let totalValue: bigint

  if (isNative) {
    data = encodeFunctionData({
      abi: MAYAN_FORWARDER_ABI,
      functionName: 'forwardEth',
      args: [protocolContract as `0x${string}`, protocolData],
    })
    totalValue = amountIn + extraValue
  } else {
    data = encodeFunctionData({
      abi: MAYAN_FORWARDER_ABI,
      functionName: 'forwardERC20',
      args: [
        quote.fromToken.contract as `0x${string}`,
        amountIn,
        EMPTY_PERMIT,
        protocolContract as `0x${string}`,
        protocolData,
      ],
    })
    totalValue = extraValue
  }

  return {
    to: MAYAN_FORWARDER as `0x${string}`,
    data: tagCalldata(data) as `0x${string}`,
    value: totalValue.toString(),
  }
}

export async function executeMayan(
  params: MayanQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    let quote = (providerData as { quote: MayanQuoteItem; allQuotes: MayanQuoteItem[] } | undefined)?.quote
    if (!quote || !quoteParamsMatch(lastParams, params)) {
      onStep?.('Fetching quote...')
      const routes = await getMayanQuotes(params)
      const validRoute = routes.find(r => r !== null)
      if (!validRoute) return { success: false }
      quote = lastQuote?.best
    }
    if (!quote) return { success: false }

    const fromAddr = getTokenAddress(params.token, params.fromChainId)
    if (!fromAddr) return { success: false }
    const isNative = fromAddr.toLowerCase() === NATIVE.toLowerCase()

    // Build tx calldata locally (no external swap API)
    onStep?.('Preparing transaction...')
    const tx = buildMayanTx(quote, params.userAddress, params.fromChainId, params.toChainId, isNative, effectiveRecipient(params))
    if (!tx) {
      console.error('[mayan] failed to build tx calldata for type:', quote.type)
      return { success: false }
    }

    const { sendTransaction, waitForReceipt, validateCalldata, verifyCalldataRecipient, approveToken } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has(MAYAN_TYPE_NAMES[quote.type] ?? '')

    // Safety: verify the tx target is in our known-contract allowlist
    if (!validateCalldata(params.fromChainId, tx.to)) {
      console.error('[mayan] forwarder not in allowlist:', tx.to, 'on chain', params.fromChainId)
      return { success: false }
    }

    // Safety: verify user address is encoded in the calldata
    if (!verifyCalldataRecipient(tx.data, effectiveRecipient(params))) {
      console.error('[mayan] calldata does not contain expected recipient — possible recipient mismatch')
      return { success: false }
    }

    // Approve the forwarder (or rAgg) to pull ERC-20 tokens
    if (!isNative) {
      onStep?.('Approving...')
      const q = quote as Record<string, unknown>
      const amountIn = BigInt((q.effectiveAmountIn64 as string) ?? params.amount)
      await approveToken(fromAddr, useRouter ? RAGG_ADDRESS : MAYAN_FORWARDER, amountIn, params.fromChainId)
    }

    // Send the bridge transaction
    onStep?.('Sending transaction...')
    let sendTx: { to: `0x${string}`; data: `0x${string}`; value: string } = { to: tx.to, data: tx.data, value: tx.value }
    if (useRouter) {
      const q = quote as Record<string, unknown>
      const amountIn = BigInt((q.effectiveAmountIn64 as string) ?? params.amount)
      sendTx = isNative
        ? wrapNativeRef(tx.to, params.toChainId, tx.data, BigInt(tx.value))
        : wrapERC20Ref(tx.to, fromAddr, amountIn, params.toChainId, tx.data, REF_UI, BigInt(tx.value))
    }
    const txHash = await sendTransaction(sendTx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)
    return { success: true, txHash }
  } catch (err) {
    console.error('[mayan] execution failed:', err)
    return { success: false }
  }
}
