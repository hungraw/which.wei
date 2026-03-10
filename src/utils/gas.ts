/**
 * Live gas cost estimation — reads real gas prices from chain RPCs.
 *
 * Uses wagmi's getGasPrice (which calls eth_gasPrice RPC) and converts
 * to USD via Chainlink/DeFiLlama native token prices.
 *
 * Gas prices are cached for 15 seconds to avoid hammering RPCs during
 * parallel quote fetches.
 */

import { rpcRequest } from './rpc'
import { getNativeTokenPriceUSD } from './prices'
import { ethGasChainIds, CHAIN_ID } from '../config/chains'

const GAS_CACHE_TTL = 15_000 // 15 seconds
const gasCache = new Map<number, { price: bigint; ts: number }>()

async function getChainGasPrice(chainId: number): Promise<bigint> {
  const cached = gasCache.get(chainId)
  if (cached && Date.now() - cached.ts < GAS_CACHE_TTL) return cached.price

  const hex = await rpcRequest<string>(chainId, 'eth_gasPrice', [])
  const price = BigInt(hex)
  gasCache.set(chainId, { price, ts: Date.now() })
  return price
}

/** Across SpokePool.depositV3 — ERC-20 path */
export const GAS_ACROSS_ERC20 = 120_000
/** Across SpokePool.depositV3 — native ETH (msg.value) path */
export const GAS_ACROSS_NATIVE = 100_000
/** ERC-20 approve (first-time, writes new slot) */
export const GAS_ERC20_APPROVE = 50_000
/** CCTP TokenMessenger.depositForBurnWithHook (on-chain: ~110k) */
export const GAS_CCTP_BURN = 120_000
/** CCTP TokenMessenger.depositForBurn — standard, no hook (on-chain: ~95k) */
export const GAS_CCTP_BURN_STANDARD = 100_000
/** CCTP MessageTransmitter.receiveMessage on destination chain (on-chain: ~100k) */
export const GAS_CCTP_RECEIVE = 120_000
/** deBridge DlnSource.createOrder — ERC-20 path */
export const GAS_DEBRIDGE_ERC20 = 250_000
/** deBridge DlnSource.createOrder — native ETH (msg.value) path */
export const GAS_DEBRIDGE_NATIVE = 200_000
/** cBridge Bridge.send — ERC-20 only (on-chain: 136k–185k) */
export const GAS_CBRIDGE_SEND = 200_000
/** Gas.zip native deposit */
export const GAS_GASZIP_DEPOSIT = 60_000
/** Eco Portal.publishAndFund — ERC-20 path */
export const GAS_ECO_PUBLISH = 300_000
/** Relay deposit — ERC-20 path */
export const GAS_RELAY_ERC20 = 150_000
/** Relay deposit — native ETH (msg.value) path */
export const GAS_RELAY_NATIVE = 120_000
/** Mayan Forwarder contract call */
export const GAS_MAYAN_FORWARD = 200_000
/** Stargate V2 bridge send (on-chain: 93k–111k) */
export const GAS_STARGATE_BRIDGE = 120_000
/** Synapse bridge via SynapseRouter */
export const GAS_SYNAPSE = 200_000
/** Orbiter bridge deposit */
export const GAS_ORBITER = 150_000

/**
 * Estimate gas cost in USD for a given chain and gas unit count.
 *
 * Flow: eth_gasPrice (cached 15s) × gasUnits → wei → USD via native price.
 * Throws if gas price or native token price is unavailable.
 */
export async function estimateGasCostUSD(
  chainId: number,
  gasUnits: number,
): Promise<number> {
  const gasPrice = await getChainGasPrice(chainId)
  const gasCostWei = gasPrice * BigInt(gasUnits)
  const nativePrice = await getNativeTokenPriceUSD(chainId)
  if (!nativePrice || nativePrice <= 0) {
    throw new Error(`No native token price for chain ${chainId}`)
  }
  return (Number(gasCostWei) / 1e18) * nativePrice
}

/** estimateGasCostUSD with automatic fallback — no caller try/catch needed. */
export async function estimateGasCostUSDSafe(chainId: number, gasUnits: number): Promise<number> {
  try {
    return await estimateGasCostUSD(chainId, gasUnits)
  } catch {
    return fallbackGasCostUSD(chainId)
  }
}

/**
 * Hardcoded fallback values — used only when live estimation fails.
 * These are intentional overestimates to avoid showing misleadingly low costs.
 */
export function fallbackGasCostUSD(chainId: number): number {
  if (chainId === CHAIN_ID.ETHEREUM) return 0.15
  if (ethGasChainIds.has(chainId)) return 0.01 // ETH L2s
  if (chainId === CHAIN_ID.POLYGON) return 0.15
  if (chainId === CHAIN_ID.BSC) return 0.15
  if (chainId === CHAIN_ID.HYPEREVM) return 0.01
  return 0.15
}

/** Estimate native gas reserve in wei for a bridge tx (gasPrice × generous limit × 2x safety). */
export async function estimateGasReserveWei(chainId: number): Promise<bigint> {
  try {
    const gasPrice = await getChainGasPrice(chainId)
    // 300k gas covers most bridge txs; 2x safety multiplier
    return gasPrice * 300_000n * 2n
  } catch {
    // Hardcoded fallbacks when RPC is unreachable (generous overestimates)
    if (chainId === CHAIN_ID.ETHEREUM) return 300_000_000_000_000n            // 0.0003 ETH (mainnet)
    if (ethGasChainIds.has(chainId)) return 100_000_000_000_000n               // 0.0001 ETH (L2s)
    if (chainId === CHAIN_ID.POLYGON) return 100_000_000_000_000_000n          // 0.1 POL
    if (chainId === CHAIN_ID.BSC) return 1_000_000_000_000_000n                // 0.001 BNB
    return 300_000_000_000_000n                                                // fallback
  }
}
