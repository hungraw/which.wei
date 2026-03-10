import { z } from 'zod/v4'
import { quoteParamsMatch, type Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenAddress, getTokenDecimals, NATIVE, ZERO_ADDR } from '../config/tokens'
import { waitForRateLimit } from '../utils/rate-limit'
import { isUSDT0OftChain } from '../config/chains'
import { estimateGasCostUSDSafe, GAS_RELAY_ERC20, GAS_RELAY_NATIVE, GAS_ERC20_APPROVE } from '../utils/gas'
import { isAbortError } from '../utils/errors'
import { REFERRAL_ADDRESS } from '../config/providers'
import { effectiveRecipient } from '../utils/recipient'

const RELAY_API = 'https://api.relay.link'

function toRelayAddress(addr: string): string {
  return addr.toLowerCase() === NATIVE.toLowerCase() ? ZERO_ADDR : addr
}

const RelayFeeSchema = z.object({
  currency: z.object({
    chainId: z.number(),
    address: z.string(),
    symbol: z.string(),
    decimals: z.number(),
  }).passthrough(),
  amount: z.string(),
  amountFormatted: z.string(),
  amountUsd: z.string(),
}).passthrough()

const RelayStepItemSchema = z.object({
  status: z.string(),
  data: z.object({
    from: z.string(),
    to: z.string(),
    data: z.string(),
    value: z.union([z.string(), z.number()]).transform(String),
  }).passthrough(),
}).passthrough()

const RelayStepSchema = z.object({
  id: z.string(),
  action: z.string().optional(),
  description: z.string().optional(),
  kind: z.string(),
  items: z.array(RelayStepItemSchema),
}).passthrough()

const RelayQuoteSchema = z.object({
  steps: z.array(RelayStepSchema),
  fees: z.object({
    relayer: RelayFeeSchema.optional(),
  }).passthrough(),
  details: z.object({
    currencyIn: z.object({
      amount: z.string(),
      amountFormatted: z.string(),
      amountUsd: z.string(),
    }).passthrough(),
    currencyOut: z.object({
      amount: z.string(),
      amountFormatted: z.string(),
      amountUsd: z.string(),
      currency: z.object({ decimals: z.number() }).passthrough(),
    }).passthrough(),
    totalImpact: z.object({
      usd: z.string(),
      percent: z.string(),
    }),
    timeEstimate: z.number(),
    rate: z.union([z.string(), z.number()]).transform(Number),
  }).passthrough(),
}).passthrough()

type RelayQuote = z.infer<typeof RelayQuoteSchema>

let lastQuote: RelayQuote | null = null
let lastParams: RelayQuoteParams | null = null

interface RelayQuoteParams {
  token: string      // symbol
  amount: string     // raw amount in smallest unit
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export function isRelaySupported(token: string, fromChainId: number, toChainId: number): boolean {
  // Treat “USDT” on HyperEVM/Ink as USDT0 (OFT) and avoid presenting Relay as a route.
  // This prevents showing destinations that will reliably return no routes.
  if (token === 'USDT') {
    if (isUSDT0OftChain(fromChainId) || isUSDT0OftChain(toChainId)) {
      return false
    }
  }

  const originCurrency = getTokenAddress(token, fromChainId)
  const destinationCurrency = getTokenAddress(token, toChainId)
  return !!(originCurrency && destinationCurrency)
}

export async function getRelayQuote(params: RelayQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId, userAddress } = params

  const originCurrency = getTokenAddress(token, fromChainId)
  const destinationCurrency = getTokenAddress(token, toChainId)
  if (!originCurrency || !destinationCurrency) return null

  const relayOrigin = toRelayAddress(originCurrency)
  const relayDest = toRelayAddress(destinationCurrency)

  try {
    await waitForRateLimit('relay')
    const res = await fetch(`${RELAY_API}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        user: userAddress,
        originChainId: fromChainId,
        destinationChainId: toChainId,
        originCurrency: relayOrigin,
        destinationCurrency: relayDest,
        amount,
        tradeType: 'EXACT_INPUT',
        referrer: REFERRAL_ADDRESS,
        recipient: effectiveRecipient(params),
      }),
    })

    if (!res.ok) return null

    const raw = await res.json()
    const data = RelayQuoteSchema.parse(raw)

    lastQuote = data
    lastParams = params

    const details = data.details
    const feeUsd = data.fees.relayer ? Number(data.fees.relayer.amountUsd) : 0
    const received = details.currencyOut.amount
    const decimals = getTokenDecimals(token, toChainId) ?? details.currencyOut.currency.decimals

    // Use real USD from API when available, fall back to naive 1:1 math for stablecoins.
    // Safe for USDC/USDT (our only Relay tokens). Would need price oracle for non-stables.
    const receivedUSD = Number(details.currencyOut.amountUsd) || Number(received) / (10 ** decimals)

    const isNativeToken = originCurrency.toLowerCase() === NATIVE.toLowerCase()
    const gasUnits = isNativeToken ? GAS_RELAY_NATIVE : GAS_RELAY_ERC20 + GAS_ERC20_APPROVE
    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, gasUnits)

    return buildRoute({
      provider: 'Relay',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: received,
      gasCostUSD,
      feeUSD: feeUsd,
      estimatedTime: details.timeEstimate,
      receivedUSD,
      providerData: data,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[relay] quote failed:', err)
    return null
  }
}

export async function executeRelay(
  params: RelayQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    let quote = (providerData as RelayQuote | undefined) ?? lastQuote
    if (!quote || !quoteParamsMatch(lastParams, params)) {
      onStep?.('Fetching quote...')
      const route = await getRelayQuote(params)
      if (!route) return { success: false }
      quote = lastQuote
    }
    if (!quote) return { success: false }

    const { sendTransaction, waitForReceipt, validateCalldata, verifyCalldataRecipient, validateApproveStep, approveToken } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('Relay')

    const inputToken = getTokenAddress(params.token, params.fromChainId)
    const isNativeETH = inputToken?.toLowerCase() === NATIVE.toLowerCase()

    for (const step of quote.steps) {
      for (const item of step.items) {
        if (step.id === 'approve') {
          if (useRouter) {
            // Approve rAgg instead of the depository
            if (inputToken && !isNativeETH) {
              onStep?.('Approving...')
              await approveToken(inputToken, RAGG_ADDRESS, BigInt(params.amount), params.fromChainId)
            }
          } else {
            const expectedToken = getTokenAddress(params.token, params.fromChainId)
            if (!validateApproveStep(item.data.data, item.data.to, expectedToken, params.fromChainId, 'relay')) {
              return { success: false }
            }
            onStep?.('Approving...')
            const txHash = await sendTransaction({
              to: item.data.to as `0x${string}`,
              data: item.data.data as `0x${string}`,
              value: String(item.data.value),
            })
            onStep?.('Confirming...')
            await waitForReceipt(txHash, params.fromChainId)
          }
        } else {
          // Validate non-approve tx.to against allowlist
          if (!validateCalldata(params.fromChainId, item.data.to)) {
            console.error('[relay] contract not in allowlist:', item.data.to, 'on chain', params.fromChainId)
            return { success: false }
          }

          // Verify recipient is encoded in non-approve calldata
          if (!verifyCalldataRecipient(item.data.data, effectiveRecipient(params))) {
            console.error('[relay] calldata does not contain expected recipient — possible recipient mismatch')
            return { success: false }
          }

          onStep?.('Sending transaction...')
          let tx: { to: `0x${string}`; data: `0x${string}`; value: string } = { to: item.data.to as `0x${string}`, data: item.data.data as `0x${string}`, value: String(item.data.value) }
          if (useRouter) {
            tx = isNativeETH
              ? wrapNativeRef(item.data.to as `0x${string}`, params.toChainId, item.data.data as `0x${string}`, BigInt(item.data.value))
              : wrapERC20Ref(item.data.to as `0x${string}`, inputToken!, BigInt(params.amount), params.toChainId, item.data.data as `0x${string}`, REF_UI, BigInt(item.data.value))
          }
          const txHash = await sendTransaction(tx)

          onStep?.('Confirming...')
          await waitForReceipt(txHash, params.fromChainId)

          return { success: true, txHash }
        }
      }
    }

    return { success: false }
  } catch (err) {
    console.error('[relay] execution failed:', err)
    return { success: false }
  }
}
