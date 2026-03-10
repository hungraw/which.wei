import { z } from 'zod/v4'
import type { Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenAddress, getTokenDecimals, NATIVE, ZERO_ADDR } from '../config/tokens'
import { estimateGasCostUSDSafe, GAS_ERC20_APPROVE, GAS_ORBITER } from '../utils/gas'
import { getTokenPriceUSD } from '../utils/prices'
import { waitForRateLimit } from '../utils/rate-limit'
import { isAbortError } from '../utils/errors'
import { CHAIN_ID } from '../config/chains'
import { effectiveRecipient } from '../utils/recipient'

const ORBITER_API = 'https://openapi.orbiter.finance'

const ORBITER_CHAINS: Set<number> = new Set([CHAIN_ID.ETHEREUM, CHAIN_ID.BASE, CHAIN_ID.ARBITRUM, CHAIN_ID.OPTIMISM, CHAIN_ID.POLYGON, CHAIN_ID.BSC, CHAIN_ID.INK])


const DEFAULT_TIME_SEC = 30

function toOrbiterToken(tokenAddress: string): string {
  return tokenAddress.toLowerCase() === NATIVE.toLowerCase() ? ZERO_ADDR : tokenAddress
}

function parseLimitToRaw(value: string, decimals: number, forceHuman = false): bigint | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^\d+$/.test(trimmed)) {
    if (forceHuman) {
      return BigInt(trimmed) * (10n ** BigInt(decimals))
    }
    return BigInt(trimmed)
  }

  const m = trimmed.match(/^(\d+)\.(\d+)$/)
  if (!m) return null

  const [, whole, frac] = m
  if (frac.length > decimals) return null

  const base = 10n ** BigInt(decimals)
  const wholeRaw = BigInt(whole) * base
  const fracRaw = BigInt(frac.padEnd(decimals, '0'))
  return wholeRaw + fracRaw
}

const OrbiterTxSchema = z.object({
  data: z.string(),
  to: z.string(),
  value: z.string(),
})

const OrbiterStepSchema = z.object({
  action: z.string(),
  tx: OrbiterTxSchema,
})

const OrbiterDetailsSchema = z.object({
  sourceTokenAmount: z.string(),
  destTokenAmount: z.string(),
  minDestTokenAmount: z.string(),
  limit: z.object({
    min: z.string(),
    max: z.string(),
  }).optional(),
})

const OrbiterQuoteSchema = z.object({
  status: z.literal('success'),
  result: z.object({
    steps: z.array(OrbiterStepSchema),
    details: OrbiterDetailsSchema,
  }),
})

export function isOrbiterSupported(fromChainId: number, toChainId: number): boolean {
  return ORBITER_CHAINS.has(fromChainId) && ORBITER_CHAINS.has(toChainId) && fromChainId !== toChainId
}

interface OrbiterQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

export async function getOrbiterQuote(params: OrbiterQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId, userAddress } = params

  const fromToken = getTokenAddress(token, fromChainId)
  const toToken = getTokenAddress(token, toChainId)
  if (!fromToken || !toToken) return null

  try {
    await waitForRateLimit('orbiter')
    const res = await fetch(`${ORBITER_API}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        sourceChainId: String(fromChainId),
        destChainId: String(toChainId),
        sourceToken: toOrbiterToken(fromToken),
        destToken: toOrbiterToken(toToken),
        amount,
        userAddress,
        targetRecipient: effectiveRecipient(params),
      }),
    })
    if (!res.ok) return null

    const raw = await res.json()
    const data = OrbiterQuoteSchema.parse(raw)

    const received = data.result.details.destTokenAmount
    const minReceived = data.result.details.minDestTokenAmount
    const limits = data.result.details.limit
    const fromDecimals = getTokenDecimals(token, fromChainId) ?? 6

    if (limits) {
      const amountBn = BigInt(amount)
      const useHumanScale = limits.min.includes('.') || limits.max.includes('.')
      const minBn = parseLimitToRaw(limits.min, fromDecimals, useHumanScale)
      const maxBn = parseLimitToRaw(limits.max, fromDecimals, useHumanScale)

      if (minBn === null || maxBn === null) {
        console.warn('[orbiter] unparseable limits format:', { min: limits.min, max: limits.max, decimals: fromDecimals })
      } else {
        if (amountBn < minBn || amountBn > maxBn) {
          console.warn('[orbiter] amount outside limits:', { amount, min: limits.min, max: limits.max })
          return null
        }
      }
    }

    const bridgeStep = data.result.steps.find(s => s.action === 'bridge')
    if (!bridgeStep) return null

    // Ignore zero-output quotes
    if (BigInt(received) <= 0n) return null

    const toDecimals = getTokenDecimals(token, toChainId) ?? 6
    const fromDivisor = 10 ** fromDecimals
    const toDivisor = 10 ** toDecimals

    const inputTokenAmount = Number(amount) / fromDivisor
    const outputTokenAmount = Number(received) / toDivisor
    const tokenPriceUSD = await getTokenPriceUSD(token, toChainId)
    const feeTokenAmount = Math.max(0, inputTokenAmount - outputTokenAmount)
    const feeUSD = tokenPriceUSD ? feeTokenAmount * tokenPriceUSD : feeTokenAmount

    // Gas estimation
    const isNativeETH = fromToken.toLowerCase() === NATIVE.toLowerCase()
    const gasUnits = isNativeETH ? GAS_ORBITER : GAS_ORBITER + GAS_ERC20_APPROVE
    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, gasUnits)

    return buildRoute({
      provider: 'Orbiter',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: received,
      gasCostUSD,
      feeUSD,
      estimatedTime: DEFAULT_TIME_SEC,
      receivedUSD: tokenPriceUSD ? outputTokenAmount * tokenPriceUSD : outputTokenAmount,
      providerData: {
        steps: data.result.steps,
        minReceived,
        fromToken,
        toToken,
      },
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[orbiter] quote failed:', err)
    return null
  }
}

interface OrbiterProviderData {
  steps: z.infer<typeof OrbiterStepSchema>[]
  minReceived: string
  fromToken: string
  toToken: string
}

export async function executeOrbiter(
  params: OrbiterQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    let pd = providerData as OrbiterProviderData | undefined

    // Re-fetch if no cached provider data
    if (!pd) {
      onStep?.('Fetching quote...')
      const route = await getOrbiterQuote(params)
      if (!route) return { success: false }
      pd = route._providerData as OrbiterProviderData
    }
    if (!pd) return { success: false }

    const bridgeStep = pd.steps.find(s => s.action === 'bridge')
    if (!bridgeStep) return { success: false }

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata, verifyCalldataRecipient } =
      await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, wrapNativeRef, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('Orbiter')

    const callTo = bridgeStep.tx.to
    const callData = bridgeStep.tx.data
    const callValue = bridgeStep.tx.value

    // Validate router against allowlist
    if (!validateCalldata(params.fromChainId, callTo)) {
      console.error('[orbiter] Router address not in allowlist:', callTo)
      return { success: false }
    }

    if (!verifyCalldataRecipient(callData, effectiveRecipient(params))) {
      console.error('[orbiter] calldata does not contain expected recipient — possible recipient mismatch')
      return { success: false }
    }

    const fromToken = pd.fromToken ?? getTokenAddress(params.token, params.fromChainId)
    const isNativeETH = fromToken?.toLowerCase() === NATIVE.toLowerCase()

    // ERC-20 approval to router contract
    if (fromToken && !isNativeETH) {
      onStep?.('Approving...')
      await approveToken(fromToken, useRouter ? RAGG_ADDRESS : callTo, BigInt(params.amount), params.fromChainId)
    }

    onStep?.('Sending transaction...')
    let bridgeTx = { to: callTo, data: callData, value: callValue }
    if (useRouter) {
      bridgeTx = isNativeETH
        ? wrapNativeRef(callTo, params.toChainId, callData, BigInt(callValue))
        : wrapERC20Ref(callTo, fromToken!, BigInt(params.amount), params.toChainId, callData, REF_UI, BigInt(callValue))
    }
    const txHash = await sendTransaction(bridgeTx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, params.fromChainId)

    return { success: true, txHash }
  } catch (err) {
    console.error('[orbiter] execution failed:', err)
    return { success: false }
  }
}
