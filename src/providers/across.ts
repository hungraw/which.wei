import { z } from 'zod/v4'
import { encodeFunctionData } from 'viem'
import { quoteParamsMatch, type Route } from '../core/types'
import { effectiveRecipient } from '../utils/recipient'
import { buildRoute } from '../core/quote'
import { ACROSS_BASE_URL, REFERRAL_ADDRESS, tagCalldata } from '../config/providers'
import { getTokenAddress, getTokenDecimals, NATIVE } from '../config/tokens'
import { estimateGasCostUSDSafe, GAS_ACROSS_ERC20, GAS_ACROSS_NATIVE, GAS_ERC20_APPROVE } from '../utils/gas'
import { getTokenPriceUSD } from '../utils/prices'
import { waitForRateLimit } from '../utils/rate-limit'
import { isAbortError } from '../utils/errors'
import { CHAIN_ID, isUSDT0OftChain } from '../config/chains'

/** Across uses WETH, not native ETH — map per chain.
 * HyperEVM (999) intentionally omitted — no verified WETH contract.
 * ETH routes to/from HyperEVM will return null (no route available). */
const WETH: Record<number, string> = {
  [CHAIN_ID.ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  [CHAIN_ID.BASE]:     '0x4200000000000000000000000000000000000006',
  [CHAIN_ID.ARBITRUM]: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  [CHAIN_ID.OPTIMISM]: '0x4200000000000000000000000000000000000006',
  [CHAIN_ID.POLYGON]:  '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  [CHAIN_ID.INK]:      '0x4200000000000000000000000000000000000006',
}

function toAcrossToken(tokenAddress: string, chainId: number): string | null {
  if (tokenAddress.toLowerCase() === NATIVE.toLowerCase()) return WETH[chainId] ?? null
  return tokenAddress
}

export function isAcrossSupported(token: string, fromChainId: number, toChainId: number): boolean {
  // If either side is a USDT0-only chain, we don't treat Across as supporting “USDT”.
  // Those “USDT” addresses are actually LayerZero OFT contracts.
  if (token === 'USDT') {
    if (isUSDT0OftChain(fromChainId) || isUSDT0OftChain(toChainId)) {
      return false
    }
  }

  const src = getTokenAddress(token, fromChainId)
  const dst = getTokenAddress(token, toChainId)
  if (!src || !dst) return false

  // Execution calldata requires both input and output tokens to be representable.
  return !!(toAcrossToken(src, fromChainId) && toAcrossToken(dst, toChainId))
}

// Across API returns some numeric fields as strings — coerce safely
const numericString = z.union([z.string(), z.number()]).transform(Number)

const SuggestedFeesSchema = z.object({
  totalRelayFee: z.object({
    total: z.string(),
    pct: z.string(),
  }),
  estimatedFillTimeSec: z.number(),
  spokePoolAddress: z.string(),
  outputAmount: z.string().optional(),
  fillDeadline: numericString.optional(),
  exclusiveRelayer: z.string().optional(),
  exclusivityDeadline: numericString.optional(),
  timestamp: numericString.optional(),
})

type SuggestedFees = z.infer<typeof SuggestedFeesSchema>

const SPOKE_POOL_ABI = [
  {
    inputs: [
      { name: 'depositor', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'inputToken', type: 'address' },
      { name: 'outputToken', type: 'address' },
      { name: 'inputAmount', type: 'uint256' },
      { name: 'outputAmount', type: 'uint256' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'exclusiveRelayer', type: 'address' },
      { name: 'quoteTimestamp', type: 'uint32' },
      { name: 'fillDeadline', type: 'uint32' },
      { name: 'exclusivityDeadline', type: 'uint32' },
      { name: 'message', type: 'bytes' },
    ],
    name: 'depositV3',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const

interface AcrossQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

let lastFees: SuggestedFees | null = null
let lastQuoteParams: AcrossQuoteParams | null = null

const DEFAULT_FILL_DEADLINE_SEC = 3600

export async function getAcrossQuote(params: AcrossQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId } = params
  const rawAddress = getTokenAddress(token, fromChainId)
  if (!rawAddress) return null

  const tokenAddress = toAcrossToken(rawAddress, fromChainId)
  if (!tokenAddress) return null

  const url = new URL(`${ACROSS_BASE_URL}/suggested-fees`)
  url.searchParams.set('token', tokenAddress)
  url.searchParams.set('amount', amount)
  url.searchParams.set('originChainId', String(fromChainId))
  url.searchParams.set('destinationChainId', String(toChainId))
  url.searchParams.set('recipient', effectiveRecipient(params))
  url.searchParams.set('referrer', REFERRAL_ADDRESS)

  // BNB Chain uses 18-decimal Binance-Peg stablecoins while other chains use 6.
  // Across requires explicit opt-in for cross-decimal bridging.
  const fromDecimals_ = getTokenDecimals(token, fromChainId)
  const toDecimals_ = getTokenDecimals(token, toChainId)
  if (fromDecimals_ && toDecimals_ && fromDecimals_ !== toDecimals_) {
    url.searchParams.set('allowUnmatchedDecimals', 'true')
  }

  try {
    await waitForRateLimit('across')
    const res = await fetch(url.toString(), { signal })
    if (!res.ok) return null

    const raw = await res.json()
    const data = SuggestedFeesSchema.parse(raw)

    lastFees = data
    lastQuoteParams = params

    const feeWei = BigInt(data.totalRelayFee.total)
    const amountBig = BigInt(amount)
    // Guard against fee exceeding amount (would produce negative received)
    const received = data.outputAmount ?? (feeWei >= amountBig ? '0' : (amountBig - feeWei).toString())

    const fromDecimals = getTokenDecimals(token, fromChainId) ?? 6
    const toDecimals = getTokenDecimals(token, toChainId) ?? 6
    const fromDivisor = 10 ** fromDecimals
    const toDivisor = 10 ** toDecimals

    const feePct = Number(data.totalRelayFee.pct) / 1e18
    const inputTokenAmount = Number(amount) / fromDivisor
    const feeTokenAmount = inputTokenAmount * feePct
    const tokenPriceUSD = await getTokenPriceUSD(token, fromChainId)
    const feeUSD = tokenPriceUSD ? feeTokenAmount * tokenPriceUSD : feeTokenAmount

    const isNativeETH = rawAddress.toLowerCase() === NATIVE.toLowerCase()
    const gasUnits = isNativeETH ? GAS_ACROSS_NATIVE : GAS_ACROSS_ERC20 + GAS_ERC20_APPROVE
    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, gasUnits)

    const receivedTokenAmount = Number(received) / toDivisor
    const tokenPriceOutUSD = await getTokenPriceUSD(token, toChainId)
    const receivedUSD = tokenPriceOutUSD ? receivedTokenAmount * tokenPriceOutUSD : receivedTokenAmount

    return buildRoute({
      provider: 'Across',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: received,
      gasCostUSD,
      feeUSD,
      estimatedTime: data.estimatedFillTimeSec,
      receivedUSD,
      providerData: data,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[across] quote failed:', err)
    return null
  }
}

interface AcrossDepositParams {
  fromChainId: number
  toChainId: number
  token: string
  amount: string
  userAddress: string
  recipient?: string
}

function buildDepositCalldata(
  params: AcrossDepositParams,
  fees: SuggestedFees,
): { to: string; data: string; value: string } | null {
  const { fromChainId, toChainId, token, amount, userAddress } = params
  const rawInputToken = getTokenAddress(token, fromChainId)
  const rawOutputToken = getTokenAddress(token, toChainId)
  if (!rawInputToken || !rawOutputToken) return null

  const inputToken = toAcrossToken(rawInputToken, fromChainId)
  const outputToken = toAcrossToken(rawOutputToken, toChainId)
  if (!inputToken || !outputToken) return null

  const isNativeInput = rawInputToken.toLowerCase() === NATIVE.toLowerCase()

  const outputAmount = fees.outputAmount ?? (BigInt(amount) - BigInt(fees.totalRelayFee.total)).toString()

  const data = encodeFunctionData({
    abi: SPOKE_POOL_ABI,
    functionName: 'depositV3',
    args: [
      userAddress as `0x${string}`,
      effectiveRecipient(params) as `0x${string}`,
      inputToken as `0x${string}`,
      outputToken as `0x${string}`,
      BigInt(amount),
      BigInt(outputAmount),
      BigInt(toChainId),
      (fees.exclusiveRelayer ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
      fees.timestamp ?? Math.floor(Date.now() / 1000),
      fees.fillDeadline ?? Math.floor(Date.now() / 1000) + DEFAULT_FILL_DEADLINE_SEC,
      fees.exclusivityDeadline ?? 0,
      '0x' as `0x${string}`,
    ],
  })

  return {
    to: fees.spokePoolAddress,
    data: tagCalldata(data),
    // For native ETH: send value with the tx (SpokePool wraps to WETH internally)
    value: isNativeInput ? amount : '0',
  }
}

export async function executeAcross(
  params: AcrossDepositParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    let fees = (providerData as SuggestedFees | undefined) ?? lastFees
    if (!fees || !quoteParamsMatch(lastQuoteParams, params)) {
      onStep?.('Fetching quote...')
      const refreshed = await getAcrossQuote({
        token: params.token,
        amount: params.amount,
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        userAddress: params.userAddress,
        recipient: params.recipient,
      })
      if (!refreshed) return { success: false }
      fees = lastFees
    }
    if (!fees) return { success: false }

    const calldata = buildDepositCalldata(params, fees)
    if (!calldata) return { success: false }

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('Across')

    if (!validateCalldata(params.fromChainId, calldata.to)) {
      console.error('[across] SpokePool address not in allowlist:', calldata.to)
      return { success: false }
    }

    const inputToken = getTokenAddress(params.token, params.fromChainId)
    const isNativeETH = inputToken?.toLowerCase() === NATIVE.toLowerCase()

    // Approve SpokePool (or rAgg) to spend tokens (skip for native ETH — sent as msg.value)
    if (inputToken && !isNativeETH) {
      onStep?.('Approving...')
      await approveToken(inputToken, useRouter ? RAGG_ADDRESS : fees.spokePoolAddress, BigInt(params.amount), params.fromChainId)
    }

    onStep?.('Sending deposit...')
    let tx = { to: calldata.to, data: calldata.data, value: calldata.value }
    if (useRouter) {
      tx = isNativeETH
        ? wrapNativeRef(calldata.to, params.toChainId, calldata.data, BigInt(calldata.value))
        : wrapERC20Ref(calldata.to, inputToken!, BigInt(params.amount), params.toChainId, calldata.data)
    }
    const txHash = await sendTransaction(tx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)

    return { success: true, txHash }
  } catch (err) {
    console.error('[across] execution failed:', err)
    return { success: false }
  }
}


