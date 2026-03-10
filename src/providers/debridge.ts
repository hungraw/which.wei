import { z } from 'zod/v4'
import { quoteParamsMatch, type Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenAddress, NATIVE, ZERO_ADDR } from '../config/tokens'
import { waitForRateLimit } from '../utils/rate-limit'
import { estimateGasCostUSDSafe, GAS_DEBRIDGE_ERC20, GAS_DEBRIDGE_NATIVE, GAS_ERC20_APPROVE } from '../utils/gas'
import { nativeWeiToUSD } from '../utils/prices'
import { isAbortError } from '../utils/errors'
import { REFERRAL_ADDRESS } from '../config/providers'
import { CHAIN_ID } from '../config/chains'
import { effectiveRecipient } from '../utils/recipient'

const DEBRIDGE_API = 'https://dln.debridge.finance/v1.0'

function toDebridgeAddress(addr: string): string {
  return addr.toLowerCase() === NATIVE.toLowerCase() ? ZERO_ADDR : addr
}

const SUPPORTED_CHAINS: Set<number> = new Set([CHAIN_ID.ETHEREUM, CHAIN_ID.OPTIMISM, CHAIN_ID.BSC, CHAIN_ID.POLYGON, CHAIN_ID.BASE, CHAIN_ID.ARBITRUM])

const DebridgeTxSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string(),
  gasLimit: z.number().optional(),
  allowanceTarget: z.string().optional(),
  allowanceValue: z.string().optional(),
})

const DebridgeTokenSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
  symbol: z.string().optional(),
  decimals: z.number(),
  amount: z.string(),
  chainId: z.number(),
  approximateUsdValue: z.number().optional(),
  approximateOperatingExpense: z.string().optional(),
  mutatedWithOperatingExpense: z.boolean().optional(),
  originApproximateUsdValue: z.number().optional(),
})

const DebridgeDstTokenSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
  symbol: z.string().optional(),
  decimals: z.number(),
  amount: z.string(),
  chainId: z.number(),
  recommendedAmount: z.string().optional(),
  maxTheoreticalAmount: z.string().optional(),
  approximateUsdValue: z.number().optional(),
  recommendedApproximateUsdValue: z.number().optional(),
  maxTheoreticalApproximateUsdValue: z.number().optional(),
})

const DebridgeCostDetailSchema = z.object({
  chain: z.string().optional(),
  tokenIn: z.string().optional(),
  tokenOut: z.string().optional(),
  amountIn: z.string().optional(),
  amountOut: z.string().optional(),
  type: z.string().optional(),
  payload: z.object({
    feeAmount: z.string().optional(),
    feeBps: z.string().optional(),
    feeApproximateUsdValue: z.string().optional(),
  }).passthrough().optional(),
}).passthrough()

const DebridgeEstimationSchema = z.object({
  srcChainTokenIn: DebridgeTokenSchema,
  dstChainTokenOut: DebridgeDstTokenSchema,
  costsDetails: z.array(DebridgeCostDetailSchema).optional(),
  srcChainTokenOut: z.object({
    amount: z.string(),
    approximateUsdValue: z.number().optional(),
  }).passthrough().optional(),
  recommendedSlippage: z.number().optional(),
})

const DebridgeOrderSchema = z.object({
  approximateFulfillmentDelay: z.number().optional(),
  salt: z.number().optional(),
}).passthrough()

const DebridgeResponseSchema = z.object({
  estimation: DebridgeEstimationSchema,
  tx: DebridgeTxSchema,
  orderId: z.string(),
  order: DebridgeOrderSchema.optional(),
  fixFee: z.string().optional(),
  userPoints: z.number().optional(),
  integratorPoints: z.number().optional(),
  prependedOperatingExpenseCost: z.string().optional(),
})

type DebridgeResponse = z.infer<typeof DebridgeResponseSchema>

let lastResponse: DebridgeResponse | null = null
let lastParams: DebridgeQuoteParams | null = null

const DEFAULT_FULFILLMENT_DELAY_SEC = 12

interface DebridgeQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export function isDebridgeSupported(token: string, fromChainId: number, toChainId: number): boolean {
  if (!SUPPORTED_CHAINS.has(fromChainId) || !SUPPORTED_CHAINS.has(toChainId)) return false
  const srcAddr = getTokenAddress(token, fromChainId)
  const dstAddr = getTokenAddress(token, toChainId)
  return !!(srcAddr && dstAddr)
}

export async function getDebridgeQuote(params: DebridgeQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId, userAddress } = params

  if (!isDebridgeSupported(token, fromChainId, toChainId)) return null

  const srcTokenAddress = getTokenAddress(token, fromChainId)
  const dstTokenAddress = getTokenAddress(token, toChainId)
  if (!srcTokenAddress || !dstTokenAddress) return null

  const srcToken = toDebridgeAddress(srcTokenAddress)
  const dstToken = toDebridgeAddress(dstTokenAddress)

  const url = new URL(`${DEBRIDGE_API}/dln/order/create-tx`)
  url.searchParams.set('srcChainId', String(fromChainId))
  url.searchParams.set('srcChainTokenIn', srcToken)
  url.searchParams.set('srcChainTokenInAmount', amount)
  url.searchParams.set('dstChainId', String(toChainId))
  url.searchParams.set('dstChainTokenOut', dstToken)
  url.searchParams.set('dstChainTokenOutAmount', 'auto')
  url.searchParams.set('dstChainTokenOutRecipient', effectiveRecipient(params))
  url.searchParams.set('srcChainOrderAuthorityAddress', userAddress)
  url.searchParams.set('dstChainOrderAuthorityAddress', userAddress)
  url.searchParams.set('prependOperatingExpenses', 'false')
  url.searchParams.set('affiliateFeePercent', '0.01')
  url.searchParams.set('affiliateFeeRecipient', REFERRAL_ADDRESS)

  try {
    await waitForRateLimit('debridge')
    const res = await fetch(url.toString(), { signal })
    if (!res.ok) return null

    const raw = await res.json()

    if (raw.errorId || raw.error) {
      console.warn('[debridge] API error:', raw.errorId ?? raw.error)
      return null
    }

    const data = DebridgeResponseSchema.parse(raw)

    lastResponse = data
    lastParams = params

    const est = data.estimation
    const dstOut = est.dstChainTokenOut
    const received = dstOut.recommendedAmount ?? dstOut.amount
    const receivedUSD = dstOut.recommendedApproximateUsdValue ?? dstOut.approximateUsdValue ?? 0

    // Calculate total fees from costsDetails
    let totalFeeUSD = 0
    if (est.costsDetails) {
      for (const cost of est.costsDetails) {
        const feeUsd = cost.payload?.feeApproximateUsdValue
        if (feeUsd) totalFeeUSD += Number(feeUsd)
      }
    }

    // If costsDetails didn't provide USD fees, calculate from input/output difference
    if (totalFeeUSD === 0) {
      const inputUSD = est.srcChainTokenIn.approximateUsdValue ?? 0
      totalFeeUSD = Math.max(0, inputUSD - receivedUSD)
    }

    const fulfillmentDelay = data.order?.approximateFulfillmentDelay ?? DEFAULT_FULFILLMENT_DELAY_SEC

    // Detect hidden fees in native-token routes: tx.value can exceed the user-entered amount
    const inputToken = getTokenAddress(token, fromChainId)
    const isNative = inputToken?.toLowerCase() === NATIVE.toLowerCase()
    if (isNative) {
      const requestedAmount = BigInt(amount)
      const actualTxValue = BigInt(data.tx.value)
      if (actualTxValue > requestedAmount) {
        const hiddenFeeWei = actualTxValue - requestedAmount
        const hiddenFeeUSD = await nativeWeiToUSD(fromChainId, hiddenFeeWei)
        if (hiddenFeeUSD !== null) totalFeeUSD += hiddenFeeUSD
      }
    }

    // Live gas estimation using provider-returned gasLimit or calibrated constant
    const gasUnits = isNative
      ? (data.tx.gasLimit ?? GAS_DEBRIDGE_NATIVE)
      : (data.tx.gasLimit ?? GAS_DEBRIDGE_ERC20) + GAS_ERC20_APPROVE
    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, gasUnits)

    return buildRoute({
      provider: 'deBridge',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: received,
      gasCostUSD,
      feeUSD: totalFeeUSD,
      estimatedTime: fulfillmentDelay,
      receivedUSD: receivedUSD,
      providerData: data,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[debridge] quote failed:', err)
    return null
  }
}

export async function executeDebridge(
  params: DebridgeQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    let response = (providerData as DebridgeResponse | undefined) ?? lastResponse
    if (!response || !quoteParamsMatch(lastParams, params)) {
      onStep?.('Fetching quote...')
      const route = await getDebridgeQuote(params)
      if (!route) return { success: false }
      response = lastResponse
    }
    if (!response) return { success: false }

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata, verifyCalldataRecipient } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('deBridge')

    const tx = response.tx

    if (!validateCalldata(params.fromChainId, tx.to)) {
      console.error('[debridge] contract not in allowlist:', tx.to, 'on chain', params.fromChainId)
      return { success: false }
    }

    // Verify user's address is encoded in the calldata (guards against API compromise)
    if (!verifyCalldataRecipient(tx.data, effectiveRecipient(params))) {
      console.error('[debridge] calldata does not contain expected recipient — possible recipient mismatch')
      return { success: false }
    }

    // Handle ERC-20 approval — deBridge may specify allowanceTarget
    const inputToken = getTokenAddress(params.token, params.fromChainId)
    const isNative = inputToken?.toLowerCase() === NATIVE.toLowerCase()

    if (inputToken && !isNative) {
      const approvalTarget = useRouter ? RAGG_ADDRESS : (tx.allowanceTarget ?? tx.to)
      // Validate allowanceTarget against allowlist when it differs from tx.to
      if (!useRouter && approvalTarget !== tx.to && !validateCalldata(params.fromChainId, approvalTarget)) {
        console.error('[debridge] allowanceTarget not in allowlist:', approvalTarget, 'on chain', params.fromChainId)
        return { success: false }
      }
      const approvalAmount = tx.allowanceValue ?? params.amount
      onStep?.('Approving...')
      await approveToken(inputToken, approvalTarget, BigInt(approvalAmount), params.fromChainId)
    }

    onStep?.('Sending transaction...')
    let bridgeTx = { to: tx.to, data: tx.data, value: tx.value }
    if (useRouter) {
      bridgeTx = isNative
        ? wrapNativeRef(tx.to, params.toChainId, tx.data, BigInt(tx.value))
        : wrapERC20Ref(tx.to, inputToken!, BigInt(tx.allowanceValue ?? params.amount), params.toChainId, tx.data, REF_UI, BigInt(tx.value))
    }
    const txHash = await sendTransaction(bridgeTx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)

    return { success: true, txHash }
  } catch (err) {
    console.error('[debridge] execution failed:', err)
    return { success: false }
  }
}


