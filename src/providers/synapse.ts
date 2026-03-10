import { z } from 'zod/v4'
import type { Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenAddress, getTokenDecimals, NATIVE } from '../config/tokens'
import { estimateGasCostUSDSafe, GAS_ERC20_APPROVE, GAS_SYNAPSE } from '../utils/gas'
import { getNativeTokenPriceUSD, getTokenPriceUSD } from '../utils/prices'
import { waitForRateLimit } from '../utils/rate-limit'
import { isAbortError } from '../utils/errors'
import { CHAIN_ID } from '../config/chains'
import { effectiveRecipient } from '../utils/recipient'

const SYNAPSE_API = 'https://api.synapseprotocol.com'

const SYNAPSE_CHAINS: Set<number> = new Set([CHAIN_ID.ETHEREUM, CHAIN_ID.BASE, CHAIN_ID.ARBITRUM, CHAIN_ID.OPTIMISM, CHAIN_ID.POLYGON, CHAIN_ID.BSC])

const SYNAPSE_UNSUPPORTED_TOKEN_CHAIN = new Set([
  'USDT:8453',
])


const QuoteItemSchema = z.object({
  id: z.string(),
  expectedToAmount: z.string(),
  minToAmount: z.string(),
  routerAddress: z.string(),
  estimatedTime: z.number(),
  moduleNames: z.array(z.string()),
  nativeFee: z.string().optional(),
})

const QuoteResponseSchema = z.array(QuoteItemSchema)

const BigNumberSchema = z.object({
  type: z.literal('BigNumber'),
  hex: z.string(),
})

const CallDataSchema = z.object({
  data: z.string(),
  to: z.string(),
  value: BigNumberSchema,
})

const BridgeItemSchema = z.object({
  routerAddress: z.string(),
  maxAmountOutStr: z.string().optional(),
  bridgeFeeFormatted: z.string().optional(),
  estimatedTime: z.number(),
  bridgeModuleName: z.string(),
  callData: CallDataSchema,
})

const BridgeResponseSchema = z.array(BridgeItemSchema)

export function isSynapseSupported(fromChainId: number, toChainId: number, token?: string): boolean {
  const chainSupported = SYNAPSE_CHAINS.has(fromChainId) && SYNAPSE_CHAINS.has(toChainId) && fromChainId !== toChainId
  if (!chainSupported) return false
  if (!token) return true
  const symbol = token.toUpperCase()
  return !SYNAPSE_UNSUPPORTED_TOKEN_CHAIN.has(`${symbol}:${fromChainId}`)
    && !SYNAPSE_UNSUPPORTED_TOKEN_CHAIN.has(`${symbol}:${toChainId}`)
}

interface SynapseQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export async function getSynapseQuote(params: SynapseQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId } = params
  if (!isSynapseSupported(fromChainId, toChainId, token)) return null

  const fromToken = getTokenAddress(token, fromChainId)
  const toToken = getTokenAddress(token, toChainId)
  if (!fromToken || !toToken) return null

  const url = new URL(`${SYNAPSE_API}/bridge/v2`)
  url.searchParams.set('fromChainId', String(fromChainId))
  url.searchParams.set('toChainId', String(toChainId))
  url.searchParams.set('fromToken', fromToken)
  url.searchParams.set('toToken', toToken)
  url.searchParams.set('fromAmount', amount)

  try {
    await waitForRateLimit('synapse')
    const res = await fetch(url.toString(), { signal })
    if (!res.ok) return null

    const raw = await res.json()
    const routes = QuoteResponseSchema.parse(raw)
    if (routes.length === 0) return null

    const best = routes.reduce((a, b) =>
      BigInt(a.expectedToAmount) >= BigInt(b.expectedToAmount) ? a : b,
    )

    if (BigInt(best.expectedToAmount) <= 0n) return null

    const fromDecimals = getTokenDecimals(token, fromChainId) ?? 6
    const toDecimals = getTokenDecimals(token, toChainId) ?? 6
    const fromDivisor = 10 ** fromDecimals
    const toDivisor = 10 ** toDecimals

    const inputTokenAmount = Number(amount) / fromDivisor
    const outputTokenAmount = Number(best.expectedToAmount) / toDivisor
    const tokenPriceUSD = await getTokenPriceUSD(token, toChainId)
    const feeTokenAmount = Math.max(0, inputTokenAmount - outputTokenAmount)
    const feeUSD = tokenPriceUSD ? feeTokenAmount * tokenPriceUSD : feeTokenAmount

    const isNativeETH = fromToken.toLowerCase() === NATIVE.toLowerCase()
    const gasUnits = isNativeETH ? GAS_SYNAPSE : GAS_SYNAPSE + GAS_ERC20_APPROVE
    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, gasUnits)

    // Synapse may charge a native-token fee on some bridge modules
    let nativeFeeUSD: number | undefined
    if (best.nativeFee && BigInt(best.nativeFee) > 0n) {
      const nativeFeeWei = Number(BigInt(best.nativeFee)) / 1e18
      const nativePrice = await getNativeTokenPriceUSD(fromChainId)
      nativeFeeUSD = nativePrice ? nativeFeeWei * nativePrice : undefined
    }

    return buildRoute({
      provider: 'Synapse',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: best.expectedToAmount,
      gasCostUSD,
      feeUSD,
      nativeFeeUSD,
      estimatedTime: best.estimatedTime,
      receivedUSD: tokenPriceUSD ? outputTokenAmount * tokenPriceUSD : outputTokenAmount,
      providerData: {
        moduleNames: best.moduleNames,
        routerAddress: best.routerAddress,
        fromToken,
        toToken,
      },
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[synapse] quote failed:', err)
    return null
  }
}

interface SynapseProviderData {
  moduleNames: string[]
  routerAddress: string
  fromToken: string
  toToken: string
}

export async function executeSynapse(
  params: SynapseQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    const pd = providerData as SynapseProviderData | undefined
    const fromToken = pd?.fromToken ?? getTokenAddress(params.token, params.fromChainId)
    const toToken = pd?.toToken ?? getTokenAddress(params.token, params.toChainId)
    if (!fromToken || !toToken) return { success: false }

    // Fetch calldata from /bridge endpoint
    onStep?.('Fetching calldata...')
    const url = new URL(`${SYNAPSE_API}/bridge`)
    url.searchParams.set('fromChain', String(params.fromChainId))
    url.searchParams.set('toChain', String(params.toChainId))
    url.searchParams.set('fromToken', fromToken)
    url.searchParams.set('toToken', toToken)
    url.searchParams.set('amount', params.amount)
    url.searchParams.set('originUserAddress', params.userAddress)
    url.searchParams.set('destAddress', effectiveRecipient(params))

    await waitForRateLimit('synapse')
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return { success: false }

    const raw = await res.json()
    const bridgeResults = BridgeResponseSchema.parse(raw)
    if (bridgeResults.length === 0) return { success: false }

    // Pick best result (first entry — API returns sorted by best output)
    const best = bridgeResults[0]
    const callTo = best.callData.to
    const callData = best.callData.data
    const callValue = BigInt(best.callData.value.hex).toString()

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata, verifyCalldataRecipient } =
      await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('Synapse')

    // Validate contract against allowlist
    if (!validateCalldata(params.fromChainId, callTo)) {
      console.error('[synapse] Router address not in allowlist:', callTo)
      return { success: false }
    }

    // Verify user address is encoded in calldata
    if (!verifyCalldataRecipient(callData, effectiveRecipient(params))) {
      console.error('[synapse] User address not found in calldata')
      return { success: false }
    }

    const isNativeETH = fromToken.toLowerCase() === NATIVE.toLowerCase()

    // ERC-20 approval to router contract
    if (!isNativeETH) {
      onStep?.('Approving...')
      await approveToken(fromToken, useRouter ? RAGG_ADDRESS : callTo, BigInt(params.amount), params.fromChainId)
    }

    onStep?.('Sending transaction...')
    let bridgeTx = { to: callTo, data: callData, value: callValue }
    if (useRouter) {
      bridgeTx = isNativeETH
        ? wrapNativeRef(callTo, params.toChainId, callData, BigInt(callValue))
        : wrapERC20Ref(callTo, fromToken, BigInt(params.amount), params.toChainId, callData, REF_UI, BigInt(callValue))
    }
    const txHash = await sendTransaction(bridgeTx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)

    return { success: true, txHash }
  } catch (err) {
    console.error('[synapse] execution failed:', err)
    return { success: false }
  }
}
