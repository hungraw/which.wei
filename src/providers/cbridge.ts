import { z } from 'zod/v4'
import { encodeFunctionData, keccak256, encodePacked } from 'viem'
import { quoteParamsMatch, type Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenDecimals } from '../config/tokens'
import { waitForRateLimit } from '../utils/rate-limit'
import { estimateGasCostUSDSafe, GAS_CBRIDGE_SEND, GAS_ERC20_APPROVE } from '../utils/gas'
import { isAbortError } from '../utils/errors'
import { tagCalldata } from '../config/providers'
import { CHAIN_ID } from '../config/chains'
import { effectiveRecipient } from '../utils/recipient'

const CBRIDGE_API = 'https://cbridge-prod2.celer.app/v2'

const BRIDGE_CONTRACT: Record<number, string> = {
  [CHAIN_ID.ETHEREUM]: '0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820',
  [CHAIN_ID.OPTIMISM]: '0x9D39Fc627A6d9d9F8C831c16995b209548cc3401',
  [CHAIN_ID.BSC]:      '0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF',
  [CHAIN_ID.POLYGON]:  '0x88DCDC47D2f83a99CF0000FDF667A468bB958a78',
  [CHAIN_ID.BASE]:     '0x7d43AABC515C356145049227CeE54B608342c0ad',
  [CHAIN_ID.ARBITRUM]: '0x1619DE6B6B20eD217a58d00f37B9d47C7663feca',
}

const CB_TOKEN: Record<string, { symbol: string; address: string }> = {
  // Ethereum
  '1:USDC':  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  '1:USDT':  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  // Optimism — USDC omitted (cBridge uses bridged USDC.e 0x7F5c764c, user has native USDC)
  '10:USDT': { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58' },
  // BNB
  '56:USDC': { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  '56:USDT': { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955' },
  // Polygon — USDC omitted (cBridge uses bridged USDC 0x2791Bca1, user has native USDC)
  '137:USDT': { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
  // Base — only USDT if supported, but cBridge has no USDC here (error 1009)
  // Arbitrum — USDC omitted (cBridge uses bridged USDC.e 0xFF970A61, user has native USDC)
  '42161:USDT': { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
}

// cBridge slippage_tolerance: 5000 = 0.5%   (value / 1M = rate)
const SLIPPAGE_TOLERANCE = 5000

const EstimateSchema = z.object({
  err: z.any(),
  eq_value_token_amt: z.string(),
  bridge_rate: z.number(),
  perc_fee: z.string(),
  base_fee: z.string(),
  slippage_tolerance: z.number(),
  max_slippage: z.number(),
  estimated_receive_amt: z.string(),
})

const LatencySchema = z.object({
  err: z.any(),
  median_transfer_latency_in_second: z.number(),
})

interface CbridgeEstimate {
  maxSlippage: number
  receivedAmt: string
  percFee: string
  baseFee: string
}

let lastEstimate: CbridgeEstimate | null = null
let lastParams: CbridgeQuoteParams | null = null

const DEFAULT_ESTIMATED_TIME_SEC = 300

const BRIDGE_ABI = [
  {
    inputs: [
      { name: '_receiver', type: 'address' },
      { name: '_token', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_dstChainId', type: 'uint64' },
      { name: '_nonce', type: 'uint64' },
      { name: '_maxSlippage', type: 'uint32' },
    ],
    name: 'send',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

interface CbridgeQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

function getCbToken(symbol: string, chainId: number) {
  return CB_TOKEN[`${chainId}:${symbol}`] ?? null
}

export function isCbridgeSupported(symbol: string, fromChainId: number, toChainId: number): boolean {
  return !!(
    BRIDGE_CONTRACT[fromChainId] &&
    BRIDGE_CONTRACT[toChainId] &&
    getCbToken(symbol, fromChainId) &&
    getCbToken(symbol, toChainId)
  )
}

export async function getCbridgeQuote(params: CbridgeQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId } = params

  const srcToken = getCbToken(token, fromChainId)
  const dstToken = getCbToken(token, toChainId)
  if (!srcToken || !dstToken) return null

  const estimateUrl = new URL(`${CBRIDGE_API}/estimateAmt`)
  estimateUrl.searchParams.set('src_chain_id', String(fromChainId))
  estimateUrl.searchParams.set('dst_chain_id', String(toChainId))
  estimateUrl.searchParams.set('token_symbol', srcToken.symbol)
  estimateUrl.searchParams.set('amt', amount)
  estimateUrl.searchParams.set('slippage_tolerance', String(SLIPPAGE_TOLERANCE))
  // usr_addr is optional for quotes — skip to avoid "blocked addr" errors

  try {
    // Fetch estimate and latency in parallel
    await waitForRateLimit('cbridge')
    const [estRes, latRes] = await Promise.all([
      fetch(estimateUrl.toString(), { signal }),
      fetch(`${CBRIDGE_API}/getLatest7DayTransferLatencyForQuery?src_chain_id=${fromChainId}&dst_chain_id=${toChainId}`, { signal }),
    ])

    if (!estRes.ok) return null
    const estRaw = await estRes.json()
    const est = EstimateSchema.parse(estRaw)

    if (est.err) {
      console.warn('[cbridge] estimate error:', est.err)
      return null
    }

    if (!est.estimated_receive_amt || est.estimated_receive_amt === '0') return null

    // Parse latency (fallback 300s if unavailable)
    let estimatedTime = DEFAULT_ESTIMATED_TIME_SEC
    if (latRes.ok) {
      try {
        const latRaw = await latRes.json()
        const lat = LatencySchema.parse(latRaw)
        if (!lat.err) estimatedTime = Math.round(lat.median_transfer_latency_in_second)
      } catch { /* use fallback */ }
    }

    // Cache estimate for execution
    lastEstimate = {
      maxSlippage: est.max_slippage,
      receivedAmt: est.estimated_receive_amt,
      percFee: est.perc_fee,
      baseFee: est.base_fee,
    }
    lastParams = params

    const fromDecimals = getTokenDecimals(token, fromChainId) ?? 6
    const toDecimals = getTokenDecimals(token, toChainId) ?? 6

    // Total fee = perc_fee + base_fee (in token decimals)
    const totalFeeToken = BigInt(est.perc_fee) + BigInt(est.base_fee)
    const feeUSD = Number(totalFeeToken) / 10 ** fromDecimals

    const receivedUSD = Number(est.estimated_receive_amt) / 10 ** toDecimals

    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, GAS_CBRIDGE_SEND + GAS_ERC20_APPROVE)

    return buildRoute({
      provider: 'cBridge',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: est.estimated_receive_amt,
      gasCostUSD,
      feeUSD,
      estimatedTime,
      receivedUSD,
      providerData: lastEstimate,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[cbridge] quote failed:', err)
    return null
  }
}

export async function executeCbridge(
  params: CbridgeQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string; providerOrderId?: string }> {
  try {
    let estimate = (providerData as CbridgeEstimate | undefined) ?? lastEstimate
    if (!estimate || !quoteParamsMatch(lastParams, params)) {
      onStep?.('Fetching quote...')
      const refreshed = await getCbridgeQuote(params)
      if (!refreshed) return { success: false }
      estimate = lastEstimate
    }
    if (!estimate) return { success: false }

    const bridgeAddr = BRIDGE_CONTRACT[params.fromChainId]
    if (!bridgeAddr) return { success: false }

    const srcToken = getCbToken(params.token, params.fromChainId)
    if (!srcToken) return { success: false }

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('cBridge')

    if (!validateCalldata(params.fromChainId, bridgeAddr)) {
      console.error('[cbridge] bridge contract not in allowlist:', bridgeAddr)
      return { success: false }
    }

    const nonce = BigInt(Date.now())

    // Approve the Bridge contract to spend tokens
    onStep?.('Approving...')
    await approveToken(srcToken.address, useRouter ? RAGG_ADDRESS : bridgeAddr, BigInt(params.amount), params.fromChainId)

    onStep?.('Sending transaction...')

    // send(receiver, token, amount, dstChainId, nonce, maxSlippage)
    const data = encodeFunctionData({
      abi: BRIDGE_ABI,
      functionName: 'send',
      args: [
        effectiveRecipient(params) as `0x${string}`,
        srcToken.address as `0x${string}`,
        BigInt(params.amount),
        BigInt(params.toChainId),
        nonce,
        estimate.maxSlippage,
      ],
    })

    const bridgeCalldata = tagCalldata(data)
    let tx = { to: bridgeAddr, data: bridgeCalldata, value: '0' }
    if (useRouter) tx = wrapERC20Ref(bridgeAddr, srcToken.address, BigInt(params.amount), params.toChainId, bridgeCalldata)
    const txHash = await sendTransaction(tx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)

    // Compute transfer_id for polling: keccak256(abi.encodePacked(sender, receiver, token, amount, dstChainId, nonce, srcChainId))
    const transferId = keccak256(encodePacked(
      ['address', 'address', 'address', 'uint256', 'uint64', 'uint64', 'uint64'],
      [
        params.userAddress as `0x${string}`,
        effectiveRecipient(params) as `0x${string}`,
        srcToken.address as `0x${string}`,
        BigInt(params.amount),
        BigInt(params.toChainId),
        nonce,
        BigInt(params.fromChainId),
      ],
    ))

    return { success: true, txHash, providerOrderId: transferId }
  } catch (err) {
    console.error('[cbridge] execution failed:', err)
    return { success: false }
  }
}
