import { z } from 'zod/v4'
import { quoteParamsMatch, type Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenDecimals, NATIVE } from '../config/tokens'
import { getNativeTokenPriceUSD, getTokenPriceUSD } from '../utils/prices'
import { waitForRateLimit } from '../utils/rate-limit'
import { isAbortError } from '../utils/errors'
import { CHAIN_ID } from '../config/chains'
import { estimateGasCostUSDSafe, GAS_ERC20_APPROVE, GAS_STARGATE_BRIDGE } from '../utils/gas'
import { effectiveRecipient } from '../utils/recipient'

/** Stargate frontend API — not publicly documented.
 * Stable since at least 2024, used by the official Stargate UI.
 * If this breaks, check https://stargate.finance for updated endpoints. */
const STARGATE_API = 'https://stargate.finance/api/v1'



/** Map chainId → Stargate chainKey */
const CHAIN_KEY: Record<number, string> = {
  [CHAIN_ID.ETHEREUM]: 'ethereum',
  [CHAIN_ID.BASE]:     'base',
  [CHAIN_ID.ARBITRUM]: 'arbitrum',
  [CHAIN_ID.OPTIMISM]: 'optimism',
  [CHAIN_ID.POLYGON]:  'polygon',
  [CHAIN_ID.BSC]:      'bsc',
  // Ink (57073) omitted — no Stargate V2 pools, all routes return 422 or OFT-only.
  // USDT0 OFT routes to Ink are handled natively by usdt0.ts.
  // HyperEVM (999) omitted — all quote requests return errors.
}

/**
 * Stargate bridgeable token addresses per chain.
 * Keyed by `${chainId}:${symbol}` → Stargate-recognized address.
 * Some chains have different addresses than our canonical tokens.ts
 * (e.g. Ink USDC.e OFT vs native USDC, legacy bridged tokens on Arb/OP).
 */
const SG_TOKEN: Record<string, string> = {
  // Ethereum
  '1:USDC':  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  '1:USDT':  '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  '1:ETH':   NATIVE,
  // Base
  '8453:USDC': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  '8453:ETH':  NATIVE,
  // Arbitrum
  '42161:USDC': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  '42161:USDT': '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  '42161:ETH':  NATIVE,
  // Optimism
  '10:USDC': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  '10:USDT': '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  '10:ETH':  NATIVE,
  // Polygon (no native ETH pool)
  '137:USDC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  '137:USDT': '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  // BNB Chain — BSC-Pegged tokens (18 decimals!)
  '56:USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  '56:USDT': '0x55d398326f99059fF775485246999027B3197955',
  // Ink (57073) omitted — no Stargate V2 pools exist.
  // USDT0 OFT routes to/from Ink are handled by usdt0.ts.
}

const MIN_AMOUNT_FACTOR = 995n
const FACTOR_DENOMINATOR = 1000n

const StargateTransactionSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string().optional(),
  from: z.string(),
})

const StargateStepSchema = z.object({
  type: z.enum(['approve', 'bridge']),
  sender: z.string(),
  chainKey: z.string(),
  transaction: StargateTransactionSchema,
})

const StargateFeeSchema = z.object({
  token: z.string(),
  chainKey: z.string(),
  amount: z.string(),
  type: z.string(),
})

const StargateQuoteSchema = z.object({
  route: z.string(),
  error: z.any().nullable(),
  srcAmount: z.string(),
  dstAmount: z.string(),
  srcAmountMin: z.string().optional(),
  srcAmountMax: z.string().optional(),
  dstAmountMin: z.string().optional(),
  srcToken: z.string(),
  dstToken: z.string(),
  srcAddress: z.string(),
  dstAddress: z.string(),
  srcChainKey: z.string(),
  dstChainKey: z.string(),
  dstNativeAmount: z.string().optional(),
  duration: z.object({ estimated: z.number() }),
  fees: z.array(StargateFeeSchema),
  steps: z.array(StargateStepSchema),
})

const StargateResponseSchema = z.object({
  quotes: z.array(StargateQuoteSchema),
  error: z.any().optional(),
})

type StargateQuote = z.infer<typeof StargateQuoteSchema>

const quoteCache = new Map<string, StargateQuote>()
let lastCacheParams: StargateQuoteParams | null = null

export interface StargateQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

function getSgToken(symbol: string, chainId: number): string | null {
  return SG_TOKEN[`${chainId}:${symbol}`] ?? null
}

export function isStargateSupported(symbol: string, fromChainId: number, toChainId: number): boolean {
  return !!(
    CHAIN_KEY[fromChainId] &&
    CHAIN_KEY[toChainId] &&
    getSgToken(symbol, fromChainId) &&
    getSgToken(symbol, toChainId)
  )
}

export async function getStargateQuotes(
  params: StargateQuoteParams,
  signal?: AbortSignal,
): Promise<[Route | null, Route | null]> {
  const { token, amount, fromChainId, toChainId, userAddress } = params

  const srcChainKey = CHAIN_KEY[fromChainId]
  const dstChainKey = CHAIN_KEY[toChainId]
  if (!srcChainKey || !dstChainKey) return [null, null]

  const srcToken = getSgToken(token, fromChainId)
  const dstToken = getSgToken(token, toChainId)
  if (!srcToken || !dstToken) return [null, null]

  const url = new URL(`${STARGATE_API}/quotes`)
  url.searchParams.set('srcChainKey', srcChainKey)
  url.searchParams.set('dstChainKey', dstChainKey)
  url.searchParams.set('srcToken', srcToken)
  url.searchParams.set('dstToken', dstToken)
  url.searchParams.set('srcAmount', amount)
  // Set a reasonable minimum output (0.5% slippage tolerance)
  const minOut = (BigInt(amount) * MIN_AMOUNT_FACTOR / FACTOR_DENOMINATOR).toString()
  url.searchParams.set('dstAmountMin', minOut)
  url.searchParams.set('srcAddress', userAddress)
  url.searchParams.set('dstAddress', effectiveRecipient(params))

  try {
    await waitForRateLimit('stargate')
    const res = await fetch(url.toString(), { signal })
    if (!res.ok) return [null, null]

    const raw = await res.json()
    const data = StargateResponseSchema.parse(raw)

    if (!data.quotes.length) return [null, null]

    quoteCache.clear()
    lastCacheParams = params

    let taxiRoute: Route | null = null
    let busRoute: Route | null = null

    for (const q of data.quotes) {
      if (q.error) continue

      const isTaxi = q.route.includes('taxi')
      const isBus = q.route.includes('bus')
      if (!isTaxi && !isBus) continue

      const toDecimals = getTokenDecimals(token, toChainId) ?? 6
      const srcDecimals = getTokenDecimals(token, fromChainId) ?? 6
      const feeNativeWei = q.fees.reduce((sum, f) => sum + BigInt(f.amount), 0n)

      const srcTokenAmount = Number(BigInt(q.srcAmount)) / 10 ** srcDecimals
      const dstTokenAmount = Number(BigInt(q.dstAmount)) / 10 ** toDecimals

      const tokenPriceUSD = await getTokenPriceUSD(token, toChainId)
      const protocolFeeToken = Math.max(0, srcTokenAmount - dstTokenAmount)
      const protocolFeeUSD = tokenPriceUSD ? protocolFeeToken * tokenPriceUSD : protocolFeeToken
      if (srcTokenAmount < dstTokenAmount) {
        console.warn('[stargate] anomaly: dstTokenAmount > srcTokenAmount', { srcTokenAmount, dstTokenAmount, route: q.route })
      }

      const nativeUSDRate = await getNativeTokenPriceUSD(fromChainId) ?? (fromChainId === CHAIN_ID.BSC ? 650 : fromChainId === CHAIN_ID.POLYGON ? 0.4 : 2500)
      const messageFeeUSD = Number(feeNativeWei) / 1e18 * nativeUSDRate
      const estimatedGasUnits = q.steps.reduce((sum, step) => {
        if (step.type === 'approve') return sum + GAS_ERC20_APPROVE
        return sum + GAS_STARGATE_BRIDGE
      }, 0)
      const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, estimatedGasUnits)
      const receivedUSD = tokenPriceUSD ? dstTokenAmount * tokenPriceUSD : dstTokenAmount

      const mode = isTaxi ? 'taxi' as const : 'bus' as const
      quoteCache.set(mode, q)

      const route = buildRoute({
        provider: isTaxi ? 'Stargate Taxi' : 'Stargate Bus',
        fromToken: token,
        toToken: token,
        fromChainId,
        toChainId,
        amountIn: amount,
        amountOut: q.dstAmount,
        gasCostUSD,
        feeUSD: protocolFeeUSD,
        nativeFeeUSD: messageFeeUSD,
        estimatedTime: q.duration.estimated,
        receivedUSD,
        providerData: q,
      })

      if (isTaxi) taxiRoute = route
      else busRoute = route
    }

    return [taxiRoute, busRoute]
  } catch (err) {
    if (isAbortError(err)) return [null, null]
    console.warn('[stargate] quote failed:', err)
    return [null, null]
  }
}

export async function executeStargate(
  params: StargateQuoteParams,
  provider: string,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  const mode = provider === 'Stargate Bus' ? 'bus' : 'taxi'

  try {
    let quote = (providerData as StargateQuote | undefined) ?? quoteCache.get(mode) ?? null
    if (!quote || !quoteParamsMatch(lastCacheParams, params)) {
      onStep?.('Fetching quote...')
      await getStargateQuotes(params)
      quote = quoteCache.get(mode) ?? null
    }
    if (!quote) return { success: false }

    const { sendTransaction, waitForReceipt, validateCalldata, verifyCalldataRecipient, validateApproveStep, approveToken } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has(provider)

    // Find the bridge step (required)
    const bridgeStep = quote.steps.find(s => s.type === 'bridge')
    if (!bridgeStep) return { success: false }

    // Validate bridge tx.to against allowlist
    if (!validateCalldata(params.fromChainId, bridgeStep.transaction.to)) {
      console.error('[stargate] contract not in allowlist:', bridgeStep.transaction.to, 'on chain', params.fromChainId)
      return { success: false }
    }

    // Verify recipient is encoded in bridge calldata
    if (!verifyCalldataRecipient(bridgeStep.transaction.data, effectiveRecipient(params))) {
      console.error('[stargate] calldata does not contain expected recipient — possible recipient mismatch')
      return { success: false }
    }

    const srcToken = getSgToken(params.token, params.fromChainId)
    const isNativeETH = srcToken?.toLowerCase() === NATIVE.toLowerCase()

    if (useRouter) {
      // rAgg routing: skip API approve step, approve to rAgg instead
      if (srcToken && !isNativeETH) {
        onStep?.('Approving...')
        await approveToken(srcToken, RAGG_ADDRESS, BigInt(params.amount), params.fromChainId)
      }

      onStep?.('Sending transaction...')
      const bridgeTx = isNativeETH
        ? wrapNativeRef(bridgeStep.transaction.to, params.toChainId, bridgeStep.transaction.data, BigInt(bridgeStep.transaction.value ?? '0'))
        : wrapERC20Ref(bridgeStep.transaction.to, srcToken!, BigInt(params.amount), params.toChainId, bridgeStep.transaction.data, REF_UI, BigInt(bridgeStep.transaction.value ?? '0'))
      const txHash = await sendTransaction(bridgeTx)

      onStep?.('Confirming...')
      await waitForReceipt(txHash, params.fromChainId)
      return { success: true, txHash }
    }

    // Direct execution: process all steps from API
    for (const step of quote.steps) {
      if (step.type === 'approve') {
        if (!validateApproveStep(step.transaction.data, step.transaction.to, srcToken, params.fromChainId, 'stargate')) {
          return { success: false }
        }
      }

      const label = step.type === 'approve' ? 'Approving...' : 'Sending transaction...'
      onStep?.(label)

      const txHash = await sendTransaction({
        to: step.transaction.to as `0x${string}`,
        data: step.transaction.data as `0x${string}`,
        value: step.transaction.value ?? '0',
      })

      onStep?.('Confirming...')
      await waitForReceipt(txHash, params.fromChainId)

      if (step.type === 'bridge') {
        return { success: true, txHash }
      }
    }

    return { success: false }
  } catch (err) {
    console.error('[stargate] execution failed:', err)
    return { success: false }
  }
}
