import { z } from 'zod/v4'
import { encodeFunctionData, keccak256, encodeAbiParameters } from 'viem'
import { quoteParamsMatch, type Route } from '../core/types'
import { buildRoute } from '../core/quote'
import { getTokenDecimals, getTokenAddress } from '../config/tokens'
import { waitForRateLimit } from '../utils/rate-limit'
import { estimateGasCostUSDSafe, GAS_ECO_PUBLISH, GAS_ERC20_APPROVE } from '../utils/gas'
import { isAbortError } from '../utils/errors'
import { CHAIN_ID } from '../config/chains'
import { effectiveRecipient } from '../utils/recipient'

const ECO_QUOTES_API = 'https://quotes.eco.com/api/v3/quotes/single'
const ECO_APP_ID = 'whichwei'

const SUPPORTED_CHAINS: Set<number> = new Set([CHAIN_ID.ETHEREUM, CHAIN_ID.OPTIMISM, CHAIN_ID.POLYGON, CHAIN_ID.BASE, CHAIN_ID.ARBITRUM, CHAIN_ID.INK])

/** Token+chain combos Eco's quote API actually supports (subset of our main token config) */
const ECO_SUPPORTED_TOKENS: Set<string> = new Set([
  '1:USDC', '1:USDT',
  '10:USDC',          // Note: 10:USDT excluded — Eco rejects USDT0 on Optimism
  '137:USDC', '137:USDT',
  '8453:USDC',
  '42161:USDC', '42161:USDT',
  '57073:USDC', '57073:USDT',
])

const EcoFeeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  token: z.object({
    address: z.string(),
    decimals: z.number(),
    symbol: z.string().optional(),
  }).passthrough().optional(),
  amount: z.string(),
}).passthrough()

const EcoQuoteResponseSchema = z.object({
  intentExecutionType: z.string().optional(),
  sourceChainID: z.number(),
  destinationChainID: z.number(),
  sourceToken: z.string(),
  destinationToken: z.string(),
  sourceAmount: z.string(),
  destinationAmount: z.string(),
  funder: z.string().optional(),
  refundRecipient: z.string().optional(),
  recipient: z.string().optional(),
  fees: z.array(EcoFeeSchema).optional(),
  deadline: z.number().optional(),
  estimatedFulfillTimeSec: z.number().optional(),
  encodedRoute: z.string().optional(),
}).passthrough()

const EcoContractsSchema = z.object({
  sourcePortal: z.string(),
  destinationPortal: z.string(),
  prover: z.string(),
}).passthrough()

const EcoResponseSchema = z.object({
  data: z.object({
    contracts: EcoContractsSchema,
    quoteResponse: EcoQuoteResponseSchema,
  }),
}).passthrough()

type EcoResponse = z.infer<typeof EcoResponseSchema>

let lastEcoResponse: EcoResponse | null = null
let lastEcoParams: EcoQuoteParams | null = null


const DEFAULT_DEADLINE_SEC = 3600

// v3 Portal ABI: publishAndFund(uint64 destination, bytes route, Reward reward, bool allowPartial)
const PUBLISH_AND_FUND_ABI = [
  {
    inputs: [
      { name: 'destination', type: 'uint64' },
      { name: 'route', type: 'bytes' },
      {
        components: [
          { name: 'deadline', type: 'uint64' },
          { name: 'creator', type: 'address' },
          { name: 'prover', type: 'address' },
          { name: 'nativeAmount', type: 'uint256' },
          {
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            name: 'tokens',
            type: 'tuple[]',
          },
        ],
        name: 'reward',
        type: 'tuple',
      },
      { name: 'allowPartial', type: 'bool' },
    ],
    name: 'publishAndFund',
    outputs: [
      { name: 'intentHash', type: 'bytes32' },
      { name: 'vault', type: 'address' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const

interface EcoQuoteParams {
  token: string
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
}

function getEcoToken(symbol: string, chainId: number): string | null {
  if (!ECO_SUPPORTED_TOKENS.has(`${chainId}:${symbol}`)) return null
  return getTokenAddress(symbol, chainId)
}

export function isEcoSupported(symbol: string, fromChainId: number, toChainId: number): boolean {
  if (!SUPPORTED_CHAINS.has(fromChainId) || !SUPPORTED_CHAINS.has(toChainId)) return false
  // Eco only supports stablecoins
  if (symbol !== 'USDC' && symbol !== 'USDT') return false
  return !!(getEcoToken(symbol, fromChainId) && getEcoToken(symbol, toChainId))
}

export async function getEcoQuote(params: EcoQuoteParams, signal?: AbortSignal): Promise<Route | null> {
  const { token, amount, fromChainId, toChainId, userAddress } = params

  if (!isEcoSupported(token, fromChainId, toChainId)) return null

  const srcToken = getEcoToken(token, fromChainId)
  const dstToken = getEcoToken(token, toChainId)
  if (!srcToken || !dstToken) return null

  try {
    await waitForRateLimit('eco')
    const res = await fetch(ECO_QUOTES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-ID': ECO_APP_ID,
      },
      signal,
      body: JSON.stringify({
        dAppID: ECO_APP_ID,
        quoteRequest: {
          sourceChainID: fromChainId,
          destinationChainID: toChainId,
          sourceToken: srcToken,
          destinationToken: dstToken,
          sourceAmount: amount,
          funder: userAddress,
          recipient: effectiveRecipient(params),
          refundRecipient: userAddress,
        },
      }),
    })

    if (!res.ok) return null

    const raw = await res.json()
    const data = EcoResponseSchema.parse(raw)

    lastEcoResponse = data
    lastEcoParams = params

    const quote = data.data.quoteResponse
    const received = quote.destinationAmount
    const srcDecimals = getTokenDecimals(token, fromChainId) ?? 6
    const dstDecimals = getTokenDecimals(token, toChainId) ?? 6
    const receivedUSD = Number(received) / (10 ** dstDecimals)

    // Calculate fees from the fee array
    let totalFeeUSD = 0
    if (quote.fees) {
      for (const fee of quote.fees) {
        const feeDecimals = fee.token?.decimals ?? srcDecimals
        totalFeeUSD += Number(fee.amount) / (10 ** feeDecimals)
      }
    }

    // If no fees reported, use input-output difference
    if (totalFeeUSD === 0) {
      const inputUSD = Number(amount) / (10 ** srcDecimals)
      totalFeeUSD = Math.max(0, inputUSD - receivedUSD)
    }

    const estimatedTime = quote.estimatedFulfillTimeSec ?? 60

    const gasCostUSD = await estimateGasCostUSDSafe(fromChainId, GAS_ECO_PUBLISH + GAS_ERC20_APPROVE)

    return buildRoute({
      provider: 'Eco',
      fromToken: token,
      toToken: token,
      fromChainId,
      toChainId,
      amountIn: amount,
      amountOut: received,
      gasCostUSD,
      feeUSD: totalFeeUSD,
      estimatedTime,
      receivedUSD,
      providerData: data,
    })
  } catch (err) {
    if (isAbortError(err)) return null
    console.warn('[eco] quote failed:', err)
    return null
  }
}

async function approveAndSend(
  portalAddress: string,
  calldata: string,
  srcToken: string | null | undefined,
  amount: bigint,
  chainId: number,
  destChainId: number,
  onStep?: (step: string) => void,
): Promise<{ success: boolean; txHash?: string }> {
  const { sendTransaction, waitForReceipt, approveToken } = await import('../wallet/transactions.ts')
  const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref } = await import('../core/ragg.ts')
  const useRouter = RAGG_PROVIDERS.has('Eco')

  if (srcToken) {
    onStep?.('Approving...')
    await approveToken(srcToken, useRouter ? RAGG_ADDRESS : portalAddress, amount, chainId)
  }

  onStep?.('Publishing intent...')
  let tx = { to: portalAddress, data: calldata, value: '0' }
  if (useRouter && srcToken) tx = wrapERC20Ref(portalAddress, srcToken, amount, destChainId, calldata)
  const txHash = await sendTransaction(tx)

  onStep?.('Confirming...')
  await waitForReceipt(txHash, chainId)

  return { success: true, txHash }
}

export async function executeEco(
  params: EcoQuoteParams,
  onStep?: (step: string) => void,
  providerData?: unknown,
): Promise<{ success: boolean; txHash?: string }> {
  try {
    let response = (providerData as EcoResponse | undefined) ?? lastEcoResponse
    if (!response || !quoteParamsMatch(lastEcoParams, params)) {
      onStep?.('Fetching quote...')
      const route = await getEcoQuote(params)
      if (!route) return { success: false }
      response = lastEcoResponse
    }
    if (!response) return { success: false }

    let quote = response.data.quoteResponse

    const nowSec = Math.floor(Date.now() / 1000)
    if (quote.deadline && nowSec >= (quote.deadline - 30)) {
      onStep?.('Refreshing quote...')
      const route = await getEcoQuote(params)
      if (!route) return { success: false }
      response = lastEcoResponse
      if (!response) return { success: false }
      quote = response.data.quoteResponse
    }

    const contracts = response.data.contracts

    const { validateCalldata } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('Eco')

    const portalAddress = contracts.sourcePortal

    if (!validateCalldata(params.fromChainId, portalAddress)) {
      console.error('[eco] Portal address not in allowlist:', portalAddress, 'on chain', params.fromChainId)
      return { success: false }
    }

    // If the quote returned encodedRoute, build publishAndFund calldata with it
    if (quote.encodedRoute) {
      const { verifyCalldataRecipient } = await import('../wallet/transactions.ts')
      if (!verifyCalldataRecipient(quote.encodedRoute, effectiveRecipient(params))) {
        console.error('[eco] encodedRoute does not contain expected recipient — possible recipient mismatch')
        return { success: false }
      }

      const srcToken = getEcoToken(params.token, params.fromChainId)
      if (!srcToken) return { success: false }

      const deadline = quote.deadline ?? (Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SEC)

      // Strip the outer ABI offset (first 32 bytes) to get the raw route bytes
      const routeBytes = ('0x' + quote.encodedRoute.slice(66)) as `0x${string}`

      const calldata = encodeFunctionData({
        abi: PUBLISH_AND_FUND_ABI,
        functionName: 'publishAndFund',
        args: [
          BigInt(params.toChainId),
          routeBytes,
          {
            deadline: BigInt(deadline),
            creator: (useRouter ? RAGG_ADDRESS : params.userAddress) as `0x${string}`,
            prover: contracts.prover as `0x${string}`,
            nativeAmount: 0n,
            tokens: [{
              token: srcToken as `0x${string}`,
              amount: BigInt(params.amount),
            }],
          },
          false,
        ],
      })

      try {
        return await approveAndSend(
          portalAddress,
          calldata,
          srcToken,
          BigInt(params.amount),
          params.fromChainId,
          params.toChainId,
          onStep,
        )
      } catch (err) {
        console.warn('[eco] encodedRoute execution failed, falling back to manual publishAndFund calldata:', err)
      }
    }

    // Fallback: build publishAndFund calldata manually with v3 structs
    const srcToken = getEcoToken(params.token, params.fromChainId)
    const dstToken = getEcoToken(params.token, params.toChainId)

    if (!srcToken || !dstToken) return { success: false }

    const salt = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [params.userAddress as `0x${string}`, BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000))]
      )
    )

    const deadline = quote.deadline ?? (Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SEC)
    const destAmount = quote.destinationAmount

    // v3 Route struct: (bytes32 salt, uint64 deadline, address portal, uint256 nativeAmount, TokenAmount[] tokens, Call[] calls)
    const route = {
      salt,
      deadline: BigInt(deadline),
      portal: contracts.destinationPortal as `0x${string}`,
      nativeAmount: 0n,
      tokens: [{
        token: dstToken as `0x${string}`,
        amount: BigInt(destAmount),
      }],
      calls: [] as readonly { target: `0x${string}`; data: `0x${string}`; value: bigint }[],
    }

    // ABI-encode the Route struct to get the raw route bytes
    const routeBytes = encodeAbiParameters(
      [{
        type: 'tuple',
        components: [
          { name: 'salt', type: 'bytes32' },
          { name: 'deadline', type: 'uint64' },
          { name: 'portal', type: 'address' },
          { name: 'nativeAmount', type: 'uint256' },
          { components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'tokens', type: 'tuple[]' },
          { components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'value', type: 'uint256' }], name: 'calls', type: 'tuple[]' },
        ],
      }],
      [route],
    )

    const calldata = encodeFunctionData({
      abi: PUBLISH_AND_FUND_ABI,
      functionName: 'publishAndFund',
      args: [
        BigInt(params.toChainId),
        routeBytes,
        {
          deadline: BigInt(deadline),
          creator: (useRouter ? RAGG_ADDRESS : params.userAddress) as `0x${string}`,
          prover: contracts.prover as `0x${string}`,
          nativeAmount: 0n,
          tokens: [{
            token: srcToken as `0x${string}`,
            amount: BigInt(params.amount),
          }],
        },
        false,
      ],
    })

    return approveAndSend(
      portalAddress,
      calldata,
      srcToken,
      BigInt(params.amount),
      params.fromChainId,
      params.toChainId,
      onStep,
    )
  } catch (err) {
    console.error('[eco] execution failed:', err)
    return { success: false }
  }
}
