import type { Route, BridgeParams, OnStep, ExecuteResult } from '../core/types'
import { buildRoute } from '../core/quote'
import { estimateGasCostUSDSafe, GAS_ERC20_APPROVE, GAS_CCTP_BURN, GAS_CCTP_BURN_STANDARD, GAS_CCTP_RECEIVE } from '../utils/gas'
import { CHAIN_ID, chainById } from '../config/chains'
import { getTokenAddress, ZERO_BYTES32 } from '../config/tokens'
import { encodeFunctionData, padHex } from 'viem'
import { isAbortError } from '../utils/errors'
import { waitForRateLimit } from '../utils/rate-limit'
import { effectiveRecipient } from '../utils/recipient'

type CCTPChainName =
  | 'Ethereum'
  | 'Optimism'
  | 'Arbitrum'
  | 'Base'
  | 'Polygon'
  | 'HyperEVM'
  | 'Ink'

// Chain ID → Bridge Kit chain enum
const CHAIN_MAP: Record<number, CCTPChainName> = {
  [CHAIN_ID.ETHEREUM]: 'Ethereum',
  [CHAIN_ID.OPTIMISM]: 'Optimism',
  [CHAIN_ID.ARBITRUM]: 'Arbitrum',
  [CHAIN_ID.BASE]: 'Base',
  [CHAIN_ID.POLYGON]: 'Polygon',
  [CHAIN_ID.HYPEREVM]: 'HyperEVM',
  [CHAIN_ID.INK]: 'Ink',
}

const ESTIMATED_TIME_SEC = 15
const FAST_FINALITY_THRESHOLD = 1000
const STANDARD_FINALITY_THRESHOLD = 0

/**
 * Estimated Standard Transfer attestation time per source chain (seconds).
 * Values from Circle docs: developers.circle.com/cctp/concepts/finality-and-block-confirmations
 *
 * L2s on Ethereum (OP Stack, Arbitrum) wait for ~65 ETH L1 blocks → ~15-19 min.
 * Chains with own consensus (HyperEVM, Polygon) achieve hard finality in seconds.
 */
const STANDARD_ATTESTATION_SEC: Record<number, number> = {
  [CHAIN_ID.ETHEREUM]:  1020, // ~65 blocks → 15-19 min (avg 17)
  [CHAIN_ID.BASE]:       1020, // OP Stack → ~65 ETH blocks → 15-19 min
  [CHAIN_ID.ARBITRUM]:   1020, // ~65 ETH blocks → 15-19 min
  [CHAIN_ID.OPTIMISM]:   1020, // OP Stack → ~65 ETH blocks → 15-19 min
  [CHAIN_ID.POLYGON]:    8,   // 2-3 blocks → ~8 sec
  [CHAIN_ID.HYPEREVM]:   5,   // 1 block → ~5 sec
  [CHAIN_ID.INK]:        1800, // OP Stack → ~65 ETH blocks → ~30 min
}
const DEFAULT_STANDARD_SEC = 1020 // conservative fallback

function estimateSlowTimeSec(fromChainId: number): number {
  return STANDARD_ATTESTATION_SEC[fromChainId] ?? DEFAULT_STANDARD_SEC
}
const BPS_DENOMINATOR = 10_000n
const IRIS_API = 'https://iris-api.circle.com'
const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const MESSAGE_TRANSMITTER = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64'
const FORWARD_POLICY = 'medium' as const
const FORWARDING_SERVICE_HOOK_DATA = '0x636374702d666f72776172640000000000000000000000000000000000000000' as const

const TOKEN_MESSENGER_ABI = [{
  type: 'function',
  name: 'depositForBurnWithHook',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' },
    { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'hookData', type: 'bytes' },
  ],
  outputs: [],
}] as const

const DEPOSIT_FOR_BURN_ABI = [{
  type: 'function',
  name: 'depositForBurn',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' },
    { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
  ],
  outputs: [],
}] as const

const MESSAGE_TRANSMITTER_ABI = [{
  type: 'function',
  name: 'receiveMessage',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'message', type: 'bytes' },
    { name: 'attestation', type: 'bytes' },
  ],
  outputs: [{ name: 'success', type: 'bool' }],
}] as const

type ForwardFeeInput = {
  low?: number | string
  medium?: number | string
  med?: number | string
  high?: number | string
}

export interface CctpFeeTier {
  finalityThreshold: number
  minimumFee: number
  forwardFee?: ForwardFeeInput
}

export interface CctpIrisMessage {
  status?: string
  message?: string
  attestation?: string
  forwardState?: string
  forwardTxHash?: string
}

interface CctpFeePlan {
  protocolFee: bigint
  forwardFee: bigint
  maxFee: bigint
  finalityThreshold: number
}

interface CctpProviderData {
  sourceDomain: number
  destinationDomain: number
  mode?: 'fast' | 'slow'
  feePlan: {
    protocolFee: string
    forwardFee: string
    maxFee: string
    finalityThreshold: number
  }
}

type CctpMessageFetchResult =
  | { status: 'ok'; message: CctpIrisMessage }
  | { status: 'pending' }
  | { status: 'retry' }
  | { status: 'error'; error: string }

export interface CctpAttestationPollResult {
  status: 'pending' | 'complete' | 'timeout' | 'error'
  message?: string
  attestation?: string
  forwardTxHash?: string
  forwardState?: string
  error?: string
}

interface CCTPQuoteParams {
  amount: string        // raw amount in smallest unit (e.g. USDC 6 decimals)
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toSafeNumber(value: number | string | undefined): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function normalizeForwardFee(input: ForwardFeeInput | undefined): Required<ForwardFeeInput> {
  return {
    low: toSafeNumber(input?.low),
    medium: toSafeNumber(input?.medium ?? input?.med),
    med: toSafeNumber(input?.med ?? input?.medium),
    high: toSafeNumber(input?.high),
  }
}

function decimalToFraction(value: number): { numerator: bigint; denominator: bigint } {
  const normalized = Number.isFinite(value)
    ? value.toString()
    : '0'

  const fixed = normalized.includes('e') || normalized.includes('E')
    ? value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
    : normalized

  const [whole, fraction = ''] = fixed.split('.')
  const numerator = BigInt(`${whole || '0'}${fraction}`)
  const denominator = 10n ** BigInt(fraction.length)
  return { numerator, denominator }
}

function toMinorUnits(value: number | string): bigint {
  if (typeof value === 'number') return BigInt(Math.max(0, Math.floor(value)))
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0n
  return BigInt(Math.max(0, Math.floor(parsed)))
}

export function calculateCctpProtocolFee(amountMinorUnits: bigint, minimumFeeBps: number): bigint {
  if (amountMinorUnits <= 0n || !Number.isFinite(minimumFeeBps) || minimumFeeBps <= 0) return 0n
  const { numerator, denominator } = decimalToFraction(minimumFeeBps)
  if (numerator <= 0n) return 0n

  const scaledDenominator = denominator * BPS_DENOMINATOR
  return (amountMinorUnits * numerator + (scaledDenominator - 1n)) / scaledDenominator
}

export function selectCctpFeeTier(
  tiers: CctpFeeTier[],
  finalityThreshold = FAST_FINALITY_THRESHOLD,
): CctpFeeTier | null {
  return tiers.find((tier) => tier.finalityThreshold === finalityThreshold) ?? null
}

function getForwardFeeForPolicy(tier: CctpFeeTier, policy: typeof FORWARD_POLICY): bigint {
  const fees = normalizeForwardFee(tier.forwardFee)
  if (policy === 'medium') return toMinorUnits(fees.medium)
  return 0n
}

function buildFeePlan(amount: bigint, tier: CctpFeeTier): CctpFeePlan {
  const protocolFee = calculateCctpProtocolFee(amount, tier.minimumFee)
  const forwardFee = getForwardFeeForPolicy(tier, FORWARD_POLICY)
  return {
    protocolFee,
    forwardFee,
    maxFee: protocolFee + forwardFee,
    finalityThreshold: tier.finalityThreshold,
  }
}

async function fetchCctpFeeTiers(
  sourceDomain: number,
  destinationDomain: number,
  signal?: AbortSignal,
  opts?: { maxAttempts?: number; initialDelayMs?: number },
): Promise<CctpFeeTier[]> {
  const url = `${IRIS_API}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}?forward=true`

  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 4)
  let delayMs = Math.max(1, opts?.initialDelayMs ?? 400)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await waitForRateLimit('cctp-fees')
    const res = await fetch(url, { signal })

    if (res.status === 404) return []
    if (res.status === 429 || res.status >= 500) {
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 4_000)
      continue
    }
    if (!res.ok) {
      throw new Error(`[cctp] fee API failed: ${res.status}`)
    }

    const raw = await res.json() as unknown
    if (!Array.isArray(raw)) throw new Error('[cctp] invalid fee API response')

    return raw
      .map((item): CctpFeeTier => ({
        finalityThreshold: Number((item as { finalityThreshold?: unknown }).finalityThreshold ?? 0),
        minimumFee: Number((item as { minimumFee?: unknown }).minimumFee ?? 0),
        forwardFee: (item as { forwardFee?: ForwardFeeInput }).forwardFee,
      }))
      .filter((item) => Number.isFinite(item.finalityThreshold))
  }

  throw new Error('[cctp] fee API unavailable after retries')
}

export async function fetchCctpMessage(
  sourceDomain: number,
  burnTxHash: string,
  signal?: AbortSignal,
): Promise<CctpMessageFetchResult> {
  const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`

  await waitForRateLimit('cctp-messages')
  const res = await fetch(url, { signal })

  if (res.status === 404) return { status: 'pending' }
  if (res.status === 429 || res.status >= 500) return { status: 'retry' }
  if (!res.ok) return { status: 'error', error: `Iris API ${res.status}` }

  const json = await res.json() as { messages?: CctpIrisMessage[] }
  const message = Array.isArray(json.messages) ? json.messages[0] : undefined
  if (!message) return { status: 'pending' }

  return { status: 'ok', message }
}

export async function pollCctpAttestation(
  sourceDomain: number,
  burnTxHash: string,
  opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; requireForwardTxHash?: boolean },
): Promise<CctpAttestationPollResult> {
  const intervalMs = opts?.intervalMs ?? 2_000
  const timeoutMs = opts?.timeoutMs ?? 20 * 60_000
  const requireForwardTxHash = opts?.requireForwardTxHash ?? false
  const startedAt = Date.now()
  let retryDelay = intervalMs

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const fetched = await fetchCctpMessage(sourceDomain, burnTxHash, opts?.signal)
      if (fetched.status === 'error') {
        return { status: 'error', error: fetched.error }
      }

      if (fetched.status === 'retry') {
        await sleep(retryDelay)
        retryDelay = Math.min(retryDelay * 2, 10_000)
        continue
      }

      retryDelay = intervalMs

      if (fetched.status === 'ok') {
        const status = String(fetched.message.status ?? '').toLowerCase()
        const message = fetched.message.message
        const attestation = fetched.message.attestation
        const forwardTxHash = fetched.message.forwardTxHash
        const forwardState = fetched.message.forwardState
        const normalizedForwardState = String(forwardState ?? '').toUpperCase()
        const hasForwardTxHash = typeof forwardTxHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(forwardTxHash)
        const forwardSettled = !requireForwardTxHash
          || (hasForwardTxHash && (normalizedForwardState === '' || normalizedForwardState === 'SUCCEEDED'))

        if (status === 'complete' && message && attestation && forwardSettled) {
          return {
            status: 'complete',
            message,
            attestation,
            forwardTxHash,
            forwardState,
          }
        }
      }

      await sleep(intervalMs)
    } catch (err) {
      if (isAbortError(err)) return { status: 'timeout' }
      return { status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { status: 'timeout' }
}

export function getCCTPChainName(chainId: number): CCTPChainName | null {
  return CHAIN_MAP[chainId] ?? null
}

export async function getCCTPQuote(params: CCTPQuoteParams, _signal?: AbortSignal): Promise<Route | null> {
  const { amount, fromChainId, toChainId } = params
  const fromChain = getCCTPChainName(fromChainId)
  const toChain = getCCTPChainName(toChainId)

  if (!fromChain || !toChain) return null

  const fromDomain = chainById.get(fromChainId)?.cctpDomain
  const toDomain = chainById.get(toChainId)?.cctpDomain
  if (fromDomain === undefined || toDomain === undefined) return null

  try {
    const amountRaw = BigInt(amount)
    const feeTiers = await fetchCctpFeeTiers(fromDomain, toDomain, _signal, {
      maxAttempts: 2,
      initialDelayMs: 200,
    })
    const fastTier = selectCctpFeeTier(feeTiers)
    if (!fastTier) return null

    const feePlan = buildFeePlan(amountRaw, fastTier)
    if (amountRaw <= feePlan.maxFee) return null

    const amountOutRaw = (amountRaw - feePlan.maxFee).toString()
    const feeUSD = Number(feePlan.maxFee) / 1e6

    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, GAS_ERC20_APPROVE + GAS_CCTP_BURN)

    const providerData: CctpProviderData = {
      sourceDomain: fromDomain,
      destinationDomain: toDomain,
      feePlan: {
        protocolFee: feePlan.protocolFee.toString(),
        forwardFee: feePlan.forwardFee.toString(),
        maxFee: feePlan.maxFee.toString(),
        finalityThreshold: feePlan.finalityThreshold,
      },
    }

    return buildRoute({
      provider: 'CCTP Fast',
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: amountOutRaw,
      gasCostUSD,
      feeUSD,
      estimatedTime: ESTIMATED_TIME_SEC,
      receivedUSD: Number(amountOutRaw) / 1e6,
      providerData,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[cctp] quote failed:', err)
    return null
  }
}

export async function executeCCTP(
  params: BridgeParams,
  onStep?: OnStep,
  providerData?: unknown,
): Promise<ExecuteResult> {
  const { fromChainId, toChainId, amount: rawAmount } = params
  const fromName = getCCTPChainName(fromChainId)
  const toName = getCCTPChainName(toChainId)
  if (!fromName || !toName) return { success: false }

  const sourceDomain = chainById.get(fromChainId)?.cctpDomain
  const destinationDomain = chainById.get(toChainId)?.cctpDomain
  if (sourceDomain === undefined || destinationDomain === undefined) return { success: false }

  const usdc = getTokenAddress('USDC', fromChainId)
  if (!usdc) return { success: false }

  try {
    const amount = BigInt(rawAmount)

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('CCTP Fast')

    if (!validateCalldata(fromChainId, TOKEN_MESSENGER)) {
      console.error('[cctp] TokenMessenger not in allowlist:', TOKEN_MESSENGER)
      return { success: false }
    }

    const cached = providerData as CctpProviderData | undefined
    let maxFee = cached?.feePlan?.maxFee ? BigInt(cached.feePlan.maxFee) : 0n
    let finalityThreshold = cached?.feePlan?.finalityThreshold ?? FAST_FINALITY_THRESHOLD

    try {
      const tiers = await fetchCctpFeeTiers(sourceDomain, destinationDomain)
      const fastTier = selectCctpFeeTier(tiers)
      if (fastTier) {
        const freshPlan = buildFeePlan(amount, fastTier)
        maxFee = freshPlan.maxFee
        finalityThreshold = freshPlan.finalityThreshold
      }
    } catch (err) {
      console.warn('[cctp] fee refresh failed, using cached fee plan:', err)
    }

    if (amount <= maxFee) {
      console.error('[cctp] amount must be greater than maxFee', { amount: amount.toString(), maxFee: maxFee.toString() })
      return { success: false }
    }

    onStep?.('Approving...')
    await approveToken(usdc, useRouter ? RAGG_ADDRESS : TOKEN_MESSENGER, amount, fromChainId)

    const burnCalldata = encodeFunctionData({
      abi: TOKEN_MESSENGER_ABI,
      functionName: 'depositForBurnWithHook',
      args: [
        amount,
        destinationDomain,
        padHex(effectiveRecipient(params) as `0x${string}`, { size: 32 }),
        usdc as `0x${string}`,
        ZERO_BYTES32,
        maxFee,
        finalityThreshold,
        FORWARDING_SERVICE_HOOK_DATA,
      ],
    })

    onStep?.('Burning on source...')
    let tx = { to: TOKEN_MESSENGER, data: burnCalldata, value: '0' }
    if (useRouter) tx = wrapERC20Ref(TOKEN_MESSENGER, usdc, amount, toChainId, burnCalldata)
    const txHash = await sendTransaction(tx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, fromChainId)

    return { success: true, txHash }
  } catch (err) {
    console.error('[cctp] execution failed:', err)
    return { success: false }
  }
}

// ============================================================================
// CCTP Slow — standard finality, no forwarding, manual claim on destination
// ============================================================================

export async function getCCTPSlowQuote(params: CCTPQuoteParams, _signal?: AbortSignal): Promise<Route | null> {
  const { amount, fromChainId, toChainId } = params
  const fromChain = getCCTPChainName(fromChainId)
  const toChain = getCCTPChainName(toChainId)

  if (!fromChain || !toChain) return null

  const fromDomain = chainById.get(fromChainId)?.cctpDomain
  const toDomain = chainById.get(toChainId)?.cctpDomain
  if (fromDomain === undefined || toDomain === undefined) return null

  try {
    const amountRaw = BigInt(amount)
    const feeTiers = await fetchCctpFeeTiers(fromDomain, toDomain, _signal, {
      maxAttempts: 2,
      initialDelayMs: 200,
    })

    // Standard finality tier — no forwarding, near-zero protocol fee
    const stdTier = selectCctpFeeTier(feeTiers, STANDARD_FINALITY_THRESHOLD)
    // Protocol fee only (no forward fee since we don't use the forwarding service)
    const protocolFee = stdTier ? calculateCctpProtocolFee(amountRaw, stdTier.minimumFee) : 0n
    if (amountRaw <= protocolFee) return null

    const amountOutRaw = (amountRaw - protocolFee).toString()
    const feeUSD = Number(protocolFee) / 1e6

    // Gas cost includes source chain (approve + burn) AND destination chain (receiveMessage)
    const [sourceGas, destGas] = await Promise.all([
      estimateGasCostUSDSafe(fromChainId, GAS_ERC20_APPROVE + GAS_CCTP_BURN_STANDARD),
      estimateGasCostUSDSafe(toChainId, GAS_CCTP_RECEIVE),
    ])
    const gasCostUSD = sourceGas + destGas

    const providerData: CctpProviderData = {
      sourceDomain: fromDomain,
      destinationDomain: toDomain,
      mode: 'slow',
      feePlan: {
        protocolFee: protocolFee.toString(),
        forwardFee: '0',
        maxFee: protocolFee.toString(),
        finalityThreshold: STANDARD_FINALITY_THRESHOLD,
      },
    }

    return buildRoute({
      provider: 'CCTP Slow',
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: amountOutRaw,
      gasCostUSD,
      feeUSD,
      estimatedTime: estimateSlowTimeSec(fromChainId),
      receivedUSD: Number(amountOutRaw) / 1e6,
      providerData,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[cctp-slow] quote failed:', err)
    return null
  }
}

export async function executeCCTPSlow(
  params: BridgeParams,
  onStep?: OnStep,
  providerData?: unknown,
): Promise<ExecuteResult> {
  const { fromChainId, toChainId, amount: rawAmount } = params
  const fromName = getCCTPChainName(fromChainId)
  const toName = getCCTPChainName(toChainId)
  if (!fromName || !toName) return { success: false }

  const sourceDomain = chainById.get(fromChainId)?.cctpDomain
  const destinationDomain = chainById.get(toChainId)?.cctpDomain
  if (sourceDomain === undefined || destinationDomain === undefined) return { success: false }

  const usdc = getTokenAddress('USDC', fromChainId)
  if (!usdc) return { success: false }

  try {
    const amount = BigInt(rawAmount)

    const { sendTransaction, waitForReceipt, approveToken, validateCalldata } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref: wrapERC20Slow } = await import('../core/ragg.ts')
    const useRouterSlow = RAGG_PROVIDERS.has('CCTP Slow')

    if (!validateCalldata(fromChainId, TOKEN_MESSENGER)) {
      console.error('[cctp-slow] TokenMessenger not in allowlist:', TOKEN_MESSENGER)
      return { success: false }
    }

    const cached = providerData as CctpProviderData | undefined
    let maxFee = cached?.feePlan?.maxFee ? BigInt(cached.feePlan.maxFee) : 0n

    // Refresh protocol fee (no forward fee for slow)
    try {
      const tiers = await fetchCctpFeeTiers(sourceDomain, destinationDomain)
      const stdTier = selectCctpFeeTier(tiers, STANDARD_FINALITY_THRESHOLD)
      if (stdTier) {
        maxFee = calculateCctpProtocolFee(amount, stdTier.minimumFee)
      }
    } catch (err) {
      console.warn('[cctp-slow] fee refresh failed, using cached fee plan:', err)
    }

    if (amount <= maxFee) {
      console.error('[cctp-slow] amount must be greater than maxFee', { amount: amount.toString(), maxFee: maxFee.toString() })
      return { success: false }
    }

    onStep?.('Approving...')
    await approveToken(usdc, useRouterSlow ? RAGG_ADDRESS : TOKEN_MESSENGER, amount, fromChainId)

    const burnCalldata = encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_ABI,
      functionName: 'depositForBurn',
      args: [
        amount,
        destinationDomain,
        padHex(effectiveRecipient(params) as `0x${string}`, { size: 32 }),
        usdc as `0x${string}`,
        ZERO_BYTES32,
        maxFee,
        STANDARD_FINALITY_THRESHOLD,
      ],
    })

    onStep?.('Burn on source...')
    let txSlow = { to: TOKEN_MESSENGER, data: burnCalldata, value: '0' }
    if (useRouterSlow) txSlow = wrapERC20Slow(TOKEN_MESSENGER, usdc, amount, toChainId, burnCalldata)
    const txHash = await sendTransaction(txSlow)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, fromChainId)

    // Don't wait for attestation inline — the tracking system will poll and
    // transition to claim-ready when attestation arrives.
    onStep?.('Attestation pending...')
    return {
      success: false,
      txHash,
      pending: true,
      statusText: 'Waiting for Circle attestation. You can claim USDC on the destination chain once ready.',
    }
  } catch (err) {
    console.error('[cctp-slow] execution failed:', err)
    return { success: false }
  }
}

/** Claim CCTP Slow funds on the destination chain by calling receiveMessage(). */
export async function claimCCTPSlow(
  toChainId: number,
  cctpMessage: string,
  cctpAttestation: string,
  onStep?: OnStep,
): Promise<ExecuteResult> {
  try {
    const { sendTransaction, waitForReceipt, validateCalldata } = await import('../wallet/transactions.ts')
    const { switchChain } = await import('../wallet/chain-switch.ts')

    if (!validateCalldata(toChainId, MESSAGE_TRANSMITTER)) {
      console.error('[cctp-slow] MessageTransmitter not in allowlist:', MESSAGE_TRANSMITTER)
      return { success: false }
    }

    onStep?.('Switching chain...')
    await switchChain(toChainId)

    const claimCalldata = encodeFunctionData({
      abi: MESSAGE_TRANSMITTER_ABI,
      functionName: 'receiveMessage',
      args: [
        cctpMessage as `0x${string}`,
        cctpAttestation as `0x${string}`,
      ],
    })

    onStep?.('Claiming USDC...')
    const txHash = await sendTransaction({
      to: MESSAGE_TRANSMITTER,
      data: claimCalldata,
      value: '0',
    })

    onStep?.('Confirming claim...')
    await waitForReceipt(txHash, toChainId)

    onStep?.('USDC claimed successfully.')
    return { success: true, txHash, destinationTxHash: txHash }
  } catch (err) {
    console.error('[cctp-slow] claim failed:', err)
    return { success: false }
  }
}

/**
 * Check on-chain if a CCTP message nonce has been used (i.e., receiveMessage was already called).
 * Uses raw eth_call to the destination chain's MessageTransmitter contract.
 */
export async function isCCTPSlowAlreadyClaimed(
  dstChainId: number,
  cctpMessage: string,
): Promise<boolean> {
  try {
    const chain = chainById.get(dstChainId)
    if (!chain?.rpcUrl) return false

    // CCTP V2 message format:
    // [0:4] version (uint32), [4:8] sourceDomain (uint32), [8:12] destDomain (uint32),
    // [12:44] nonce (bytes32), [44:76] sender, [76:108] recipient, ...
    // In V2, nonce is a bytes32 (32 bytes) — used DIRECTLY as usedNonces key (no hashing)
    const msg = cctpMessage.startsWith('0x') ? cctpMessage.slice(2) : cctpMessage
    // 44 bytes = 88 hex chars minimum (up to end of nonce)
    if (msg.length < 88) return false

    // Extract the full 32-byte nonce (hex chars 24-87)
    const nonceBytes32 = msg.slice(24, 88)

    // usedNonces(bytes32) selector = 0xfeb61724
    // In V2, the nonce IS the mapping key — no keccak256 hashing needed
    const calldata = `0xfeb61724${nonceBytes32}`

    const res = await fetch(chain.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: MESSAGE_TRANSMITTER, data: calldata }, 'latest'],
      }),
    })

    if (!res.ok) return false
    const json = await res.json() as { result?: string }
    if (!json.result) return false

    // usedNonces returns uint256: 1 (NONCE_USED) if used, 0 if not
    return BigInt(json.result) !== 0n
  } catch {
    return false
  }
}
