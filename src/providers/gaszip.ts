import { z } from 'zod/v4'
import type { Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getNativeTokenPriceUSD } from '../utils/prices'
import { formatUnits } from 'viem'
import { waitForRateLimit } from '../utils/rate-limit'
import { estimateGasCostUSDSafe, GAS_GASZIP_DEPOSIT } from '../utils/gas'
import { isAbortError, isUserRejectedError } from '../utils/errors'
import { effectiveRecipient } from '../utils/recipient'

const GASZIP_API = 'https://backend.gas.zip/v2'
const DEPOSIT_ADDRESS = '0x391E7C679d29bD940d63be94AD22A25d25b5A604'

/**
 * Gas.zip API returns `expected` (wei received) as a bare JSON number.
 * Wei-scale values routinely exceed Number.MAX_SAFE_INTEGER (2^53 - 1),
 * causing silent precision loss when parsed with standard JSON.parse().
 *
 * Fix: pre-process the raw JSON text to quote `expected` values as strings,
 * then use Zod to coerce them to bigint. This is zero-dependency and handles
 * any integer magnitude, matching how viem treats wei values throughout the app.
 */
const EXPECTED_RE = /"expected"\s*:\s*(-?\d+)/g

function preserveExpectedPrecision(json: string): string {
  return json.replace(EXPECTED_RE, '"expected":"$1"')
}

// Zod schema — `expected` received as string after pre-processing, parsed to bigint
const GasZipQuoteItemSchema = z.object({
  chain: z.number(),
  expected: z.string().transform((s) => BigInt(s)),
  gas: z.number(),
  speed: z.number(),
  usd: z.number(),
})

const GasZipQuoteSchema = z.object({
  expires: z.number().optional(),
  quotes: z.array(GasZipQuoteItemSchema),
  calldata: z.string().optional(),
  error: z.string().optional(),
})

let lastCalldata: string | null = null
let lastQuoteKey: string | null = null

interface GasZipQuoteParams {
  amount: string     // raw amount in wei
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export async function getGasZipQuote(params: GasZipQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { amount, fromChainId, toChainId, userAddress } = params

  try {
    const url = `${GASZIP_API}/quotes/${fromChainId}/${amount}/${toChainId}?from=${userAddress}&to=${effectiveRecipient(params)}`
    await waitForRateLimit('gaszip')
    const res = await fetch(url, { signal })
    if (!res.ok) return null

    const text = await res.text()
    const safeJson = preserveExpectedPrecision(text)
    const raw = JSON.parse(safeJson)
    const data = GasZipQuoteSchema.parse(raw)

    if (data.error) {
      console.warn('[gaszip] quote error:', data.error)
      return null
    }

    if (!data.quotes.length) return null

    if (!data.calldata) {
      console.warn('[gaszip] API returned no calldata')
      return null
    }

    const quote = data.quotes[0]
    lastCalldata = data.calldata ?? null
    lastQuoteKey = `${fromChainId}-${toChainId}-${amount}-${effectiveRecipient(params)}`

    // quote.expected is now a proper bigint — no precision guard needed
    const depositWei = BigInt(amount)
    const receivedWei = quote.expected
    if (receivedWei < 0n) {
      console.warn('[gaszip] negative expected amount')
      return null
    }

    const feeWei = depositWei > receivedWei ? (depositWei - receivedWei) : 0n

    // Convert fee to USD using native token price
    const ethPrice = await getNativeTokenPriceUSD(fromChainId)
    const feeNative = Number(formatUnits(feeWei, 18))
    const feeUSD = ethPrice && Number.isFinite(feeNative) ? feeNative * ethPrice : 0

    // amountReceived as string in wei (full precision, no Number conversion)
    const amountReceived = receivedWei.toString()
    const receivedNative = Number(formatUnits(receivedWei, 18))
    const receivedUSD = ethPrice && Number.isFinite(receivedNative) ? receivedNative * ethPrice : quote.usd

    const expiresAt = data.expires ? data.expires * 1000 : undefined

    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, GAS_GASZIP_DEPOSIT)

    return buildRoute({
      provider: 'Gas.zip',
      fromToken: 'ETH',
      toToken: 'ETH',
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: amountReceived,
      gasCostUSD,
      feeUSD,
      estimatedTime: quote.speed,
      receivedUSD,
      expiresAt,
      providerData: data.calldata ?? null,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[gaszip] quote failed:', err)
    return null
  }
}

export async function executeGasZip(
  params: GasZipQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    const key = `${params.fromChainId}-${params.toChainId}-${params.amount}-${effectiveRecipient(params)}`

    // Prefer _providerData from Route (avoids module-level cache race)
    let calldata = (providerData as string | null) ?? lastCalldata
    if (!calldata || lastQuoteKey !== key) {
      onStep?.('Fetching quote...')
      const route = await getGasZipQuote(params)
      if (!route) return { success: false }
      calldata = lastCalldata
    }

    if (!calldata) return { success: false }

    const { sendTransaction, waitForReceipt, validateCalldata, verifyCalldataRecipient } = await import('../wallet/transactions.ts')
    const { RAGG_PROVIDERS, wrapNativeRef } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('Gas.zip')

    if (!validateCalldata(params.fromChainId, DEPOSIT_ADDRESS)) {
      console.error('[gaszip] deposit address not in allowlist')
      return { success: false }
    }

    // Verify user address is encoded in the calldata (guards against API compromise)
    if (!verifyCalldataRecipient(calldata, effectiveRecipient(params))) {
      // Gas.zip calldata may not explicitly include the recipient address;
      // some deposit contracts derive recipient from msg.sender.
      console.warn('[gaszip] calldata does not contain expected recipient — continuing')
    }

    onStep?.('Sending transaction...')
    const validCalldata = calldata.startsWith('0x') ? calldata : `0x${calldata}`
    let tx = { to: DEPOSIT_ADDRESS, data: validCalldata, value: params.amount }
    if (useRouter) tx = wrapNativeRef(DEPOSIT_ADDRESS, params.toChainId, validCalldata, BigInt(params.amount))
    const txHash = await sendTransaction(tx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)

    return { success: true, txHash }
  } catch (err) {
    if (isUserRejectedError(err)) {
      console.info('[gaszip] transaction rejected in wallet')
      return { success: false }
    }
    console.error('[gaszip] execution failed:', err)
    return { success: false }
  }
}
