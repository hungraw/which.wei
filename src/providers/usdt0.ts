import type { Route, BridgeParams, OnStep } from '../core/types'
import { buildRoute } from '../core/quote'
import { PUBLICNODE_RPC, CHAIN_ID } from '../config/chains'
import { getTokenAddress, getTokenDecimals } from '../config/tokens'
import { nativeWeiToUSD } from '../utils/prices'
import { estimateGasCostUSD } from '../utils/gas'
import { tagCalldata } from '../config/providers'
import { effectiveRecipient } from '../utils/recipient'

/**
 * USDT0 deployments (Token + OFT/OFT-Adapter) from https://docs.usdt0.to/api/deployments
 *
 * Terminology:
 * - `token`: the ERC-20 the user holds on that chain (may be canonical USDT or a USDT0-native token)
 * - `oft`:   the LayerZero contract that exposes quoteSend()/send() for cross-chain transfers
 *
 * We keep this map local to avoid conflating canonical USDT with USDT0 plumbing.
 */
const USDT0_DEPLOYMENTS: Record<number, { lzEid: number; token: string; oft: string }> = {
  // Ethereum: deployments list an OFT Adapter; token is canonical USDT.
  [CHAIN_ID.ETHEREUM]: {
    lzEid: 30101,
    token: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    oft: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee',
  },
  // Arbitrum One
  [CHAIN_ID.ARBITRUM]: {
    lzEid: 30110,
    token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    oft: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92',
  },
  // Optimism
  [CHAIN_ID.OPTIMISM]: {
    lzEid: 30111,
    token: '0x01bFF41798a0BcF287b996046Ca68b395DbC1071',
    oft: '0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD',
  },
  // Polygon PoS
  [CHAIN_ID.POLYGON]: {
    lzEid: 30109,
    token: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    oft: '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13',
  },
  // HyperEVM
  [CHAIN_ID.HYPEREVM]: {
    lzEid: 30367,
    token: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    oft: '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98',
  },
  // Ink
  [CHAIN_ID.INK]: {
    lzEid: 30339,
    token: '0x0200C29006150606B650577BBE7B6248F58470c1',
    oft: '0x1cB6De532588fCA4a21B7209DE7C456AF8434A65',
  },
}

const USDT0_CHAINS = new Set(Object.keys(USDT0_DEPLOYMENTS).map(Number))

const WAGMI_CHAIN_IDS = [CHAIN_ID.ETHEREUM, CHAIN_ID.BASE, CHAIN_ID.ARBITRUM, CHAIN_ID.OPTIMISM, CHAIN_ID.POLYGON, CHAIN_ID.HYPEREVM, CHAIN_ID.BSC, CHAIN_ID.INK] as const
type WagmiChainId = typeof WAGMI_CHAIN_IDS[number]

export function getUSDT0TokenAddress(chainId: number): string | null {
  return USDT0_DEPLOYMENTS[chainId]?.token ?? null
}

// LayerZero delivery can vary substantially; use a conservative quote ETA.
const ESTIMATED_TIME_SEC = 600
const HYPEREVM_DEFAULT_ETA_SEC = 12 * 60 * 60

const USDT0_LANE_ETA_SEC: Record<string, number> = {
  // Arbitrum (rounded up from ~30-53s to conservative 1m)
  '42161-1': 1 * 60,
  '42161-137': 1 * 60,
  '42161-999': 1 * 60,
  '42161-57073': 1 * 60,
  '42161-10': 1 * 60,

  // Ethereum (rounded up from ~3m24s-3m28s)
  '1-137': 4 * 60,
  '1-42161': 4 * 60,
  '1-999': 4 * 60,
  '1-57073': 4 * 60,
  '1-10': 4 * 60,

  // Polygon (rounded up from ~1m22s-1m46s)
  '137-1': 2 * 60,
  '137-42161': 2 * 60,
  '137-999': 2 * 60,
  '137-57073': 2 * 60,
  '137-10': 2 * 60,

  // Ink (rounded up; keep destination-specific ordering)
  '57073-1': 9 * 60,
  '57073-137': 8 * 60,
  '57073-42161': 8 * 60,
  '57073-999': 8 * 60,
  '57073-10': 1 * 60,

  // Optimism (rounded up from ~15m13s-15m36s; Ink fast lane rounded up)
  '10-1': 16 * 60,
  '10-137': 16 * 60,
  '10-42161': 16 * 60,
  '10-999': 16 * 60,
  '10-57073': 2 * 60,
}

function estimatedUsdt0TimeSec(fromChainId: number, toChainId: number): number {
  if (fromChainId === CHAIN_ID.HYPEREVM) return HYPEREVM_DEFAULT_ETA_SEC

  const laneEta = USDT0_LANE_ETA_SEC[`${fromChainId}-${toChainId}`]
  if (typeof laneEta === 'number' && laneEta > 0) return laneEta

  return ESTIMATED_TIME_SEC
}
const FALLBACK_MESSAGE_FEE_USD = 0.3
const GAS_USDT0_SEND = 100_000
const MIN_AMOUNT_FACTOR = 995n
const FACTOR_DENOMINATOR = 1000n

function fallbackUsdt0NetworkGasUsd(chainId: number): number {
  if (chainId === CHAIN_ID.ETHEREUM) return 0.25
  if (chainId === CHAIN_ID.BSC) return 0.08
  // All other USDT0-supported chains have cheap gas
  return 0.02
}

function lzEid(chainId: number): number | null {
  return USDT0_DEPLOYMENTS[chainId]?.lzEid ?? null
}

const OFT_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
        name: '_sendParam',
        type: 'tuple',
      },
      { name: '_payInLzToken', type: 'bool' },
    ],
    name: 'quoteSend',
    outputs: [
      {
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
        name: 'msgFee',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
        name: '_sendParam',
        type: 'tuple',
      },
      {
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
        name: '_fee',
        type: 'tuple',
      },
      { name: '_refundAddress', type: 'address' },
    ],
    name: 'send',
    outputs: [
      {
        components: [
          { name: 'guid', type: 'bytes32' },
          { name: 'nonce', type: 'uint64' },
          {
            name: 'fee', type: 'tuple', components: [
              { name: 'nativeFee', type: 'uint256' },
              { name: 'lzTokenFee', type: 'uint256' },
            ],
          },
        ],
        name: 'msgReceipt',
        type: 'tuple',
      },
      {
        components: [
          { name: 'amountSentLD', type: 'uint256' },
          { name: 'amountReceivedLD', type: 'uint256' },
        ],
        name: 'oftReceipt',
        type: 'tuple',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const

interface USDT0QuoteParams {
  amount: string
  fromChainId: number
  toChainId: number
  userAddress: string
  recipient?: string
  tokenSymbol?: string
}

export async function getUSDT0Quote(params: USDT0QuoteParams, _signal?: AbortSignal): Promise<Route | null> {
  const { amount, fromChainId, toChainId } = params
  const tokenSymbol = params.tokenSymbol ?? 'USDT'

  if (!USDT0_CHAINS.has(fromChainId) || !USDT0_CHAINS.has(toChainId)) return null

  const dstEid = lzEid(toChainId)
  if (!dstEid) return null

  const from = USDT0_DEPLOYMENTS[fromChainId]
  if (!from) return null

  const oftAddress = from.oft
  const expectedToken = from.token
  // Validate the token address the user holds matches the USDT0 deployment token.
  // For 'USDT' routes: matches on ETH/ARB/POL (same address), mismatches on OP (legacy vs USDT0).
  // For 'USDT0' routes: matches on all USDT0 deployment chains.
  const localToken = getTokenAddress(tokenSymbol, fromChainId)
  if (!localToken || localToken.toLowerCase() !== expectedToken.toLowerCase()) {
    return null
  }

  // quoteSend nativeFee is a LayerZero messaging fee (separate from network gas).
  let feeUSD = FALLBACK_MESSAGE_FEE_USD
  // OFT standard truncates to sharedDecimals (6) when converting LD→SD.
  // Since USDT is 6 decimals on all our chains, no dust is removed (LD == SD).
  // If we ever add chains with >6 decimal USDT, this must account for truncation.
  const received = amount
  // Determine what token symbol the destination chain recognizes
  const toTokenSymbol = getTokenAddress('USDT0', toChainId) ? 'USDT0'
    : getTokenAddress('USDT', toChainId) ? 'USDT' : tokenSymbol
  const toDecimals = getTokenDecimals(toTokenSymbol, toChainId) ?? 6

  // Network gas for approve + send execution path.
  // This is independent from LayerZero's quoted native messaging fee.
  let gasCostUSD = fallbackUsdt0NetworkGasUsd(fromChainId)
  try {
    const estimatedGasUsd = await estimateGasCostUSD(fromChainId, GAS_USDT0_SEND)
    if (Number.isFinite(estimatedGasUsd) && estimatedGasUsd > 0) {
      gasCostUSD = Math.max(estimatedGasUsd, 0.01)
    }
  } catch {
    // keep conservative fallback when live estimation is unavailable
  }

  // Call quoteSend() on-chain (view function — no wallet needed)
  try {
    const { readContract } = await import('@wagmi/core')
    const { getWagmiConfig } = await import('../wallet/connect')
    const config = getWagmiConfig()

    const amountLD = BigInt(amount)
    const minAmountLD = amountLD * MIN_AMOUNT_FACTOR / FACTOR_DENOMINATOR

    // Use dead address as placeholder recipient — fee doesn't depend on recipient
    // quoteSend expects bytes32 for recipient, so we ABI-pad to 32 bytes.
    const PLACEHOLDER = padAddress('0x000000000000000000000000000000000000dEaD')
    const sendParam = {
      dstEid,
      to: PLACEHOLDER,
      amountLD,
      minAmountLD,
      extraOptions: '0x' as `0x${string}`,
      composeMsg: '0x' as `0x${string}`,
      oftCmd: '0x' as `0x${string}`,
    }

    const fee = await readContract(config, {
      chainId: fromChainId as WagmiChainId,
      address: oftAddress as `0x${string}`,
      abi: OFT_ABI,
      functionName: 'quoteSend',
      args: [sendParam, false],
    })

    const feeInUSD = await nativeWeiToUSD(fromChainId, fee.nativeFee)
    if (feeInUSD !== null) {
      feeUSD = feeInUSD
    }
  } catch (err) {
    console.warn('[usdt0] quoteSend failed, using fallback message fee estimate:', err)
  }

  return buildRoute({
    provider: 'USDT0',
    fromToken: tokenSymbol,
    toToken: toTokenSymbol,
    fromChainId,
    toChainId,
    amountIn: amount,
    amountOut: received,
    gasCostUSD,
    feeUSD: 0,
    nativeFeeUSD: feeUSD,
    estimatedTime: estimatedUsdt0TimeSec(fromChainId, toChainId),
    receivedUSD: Number(received) / (10 ** toDecimals),
  })
}

function padAddress(addr: string): `0x${string}` {
  return ('0x' + addr.slice(2).padStart(64, '0')) as `0x${string}`
}

export async function executeUSDT0(
  params: BridgeParams,
  onStep?: OnStep,
): Promise<{ success: boolean; txHash?: string }> {
  const { fromChainId, toChainId, amount, userAddress } = params
  const tokenSymbol = params.token ?? 'USDT'
  const dstEid = lzEid(toChainId)
  if (!dstEid) return { success: false }

  const dep = USDT0_DEPLOYMENTS[fromChainId]
  if (!dep) return { success: false }

  const oftAddress = dep.oft
  const tokenAddress = dep.token
  const wagmiChainId = fromChainId as WagmiChainId

  const localToken = getTokenAddress(tokenSymbol, fromChainId)
  if (!localToken || localToken.toLowerCase() !== tokenAddress.toLowerCase()) {
    console.error('[usdt0] refusing execute: token mismatch', {
      chainId: fromChainId,
      tokenSymbol,
      localToken,
      deploymentsToken: tokenAddress,
    })
    return { success: false }
  }

  if (!WAGMI_CHAIN_IDS.includes(wagmiChainId)) {
    console.error('[usdt0] unsupported wagmi chain id for execute:', fromChainId)
    return { success: false }
  }

  try {
    const { encodeFunctionData, createPublicClient, http } = await import('viem')
    const { readContract } = await import('@wagmi/core')
    const { getWagmiConfig } = await import('../wallet/connect')
    const {
      validateCalldata,
      approveToken,
      sendTransaction,
      waitForReceipt,
    } = await import('../wallet/transactions.ts')
    const { RAGG_ADDRESS, RAGG_PROVIDERS, wrapERC20Ref, REF_UI } = await import('../core/ragg.ts')
    const useRouter = RAGG_PROVIDERS.has('USDT0')
    const isBrowser = typeof window !== 'undefined'

    if (!validateCalldata(fromChainId, oftAddress)) {
      console.error('[usdt0] USDT0 OFT/Adapter not in allowlist:', oftAddress, 'on chain', fromChainId)
      return { success: false }
    }

    const amountLD = BigInt(amount)
    const minAmountLD = amountLD * MIN_AMOUNT_FACTOR / FACTOR_DENOMINATOR // 0.5% slippage

    const sendParam = {
      dstEid,
      to: padAddress(effectiveRecipient(params)),
      amountLD,
      minAmountLD,
      extraOptions: '0x' as `0x${string}`,
      composeMsg: '0x' as `0x${string}`,
      oftCmd: '0x' as `0x${string}`,
    }

    // Get LZ messaging fee
    onStep?.('Estimating fee...')
    let fee: { nativeFee: bigint; lzTokenFee: bigint }
    if (isBrowser) {
      const config = getWagmiConfig()
      fee = await readContract(config, {
        chainId: wagmiChainId,
        address: oftAddress as `0x${string}`,
        abi: OFT_ABI,
        functionName: 'quoteSend',
        args: [sendParam, false],
      })
    } else {
      const rpc = PUBLICNODE_RPC[fromChainId]
      if (!rpc) {
        console.error('[usdt0] missing RPC for chain', fromChainId)
        return { success: false }
      }
      const client = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) })
      fee = await client.readContract({
        address: oftAddress as `0x${string}`,
        abi: OFT_ABI,
        functionName: 'quoteSend',
        args: [sendParam, false],
      })
    }

    // Approve token spending to the OFT/Adapter contract.
    // Safe-guard: approveToken never approves MAX_UINT, and USDT(ERC20) requires approve(0) reset.
    if (tokenAddress.toLowerCase() !== oftAddress.toLowerCase()) {
      onStep?.('Approving...')
      await approveToken(tokenAddress, useRouter ? RAGG_ADDRESS : oftAddress, BigInt(amount), fromChainId)
    }

    // Send via OFT
    onStep?.('Sending...')
    const calldata = encodeFunctionData({
      abi: OFT_ABI,
      functionName: 'send',
      args: [sendParam, { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee }, userAddress as `0x${string}`],
    })
    const txCalldata = tagCalldata(calldata)
    let tx = { to: oftAddress as string, data: txCalldata, value: fee.nativeFee.toString() }
    if (useRouter) tx = wrapERC20Ref(oftAddress, tokenAddress, BigInt(amount), toChainId, txCalldata, REF_UI, fee.nativeFee)
    const txHash = await sendTransaction(tx)

    onStep?.('Confirming...')
    await waitForReceipt(txHash, fromChainId)

    return { success: true, txHash }
  } catch (err) {
    console.error('[usdt0] execution failed:', err)
    return { success: false }
  }
}
