import type { Chain } from '../core/types'
import { CHAIN_ICONS } from './chain-icons'

export const CHAIN_ID = {
  ETHEREUM: 1,
  BASE: 8453,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  POLYGON: 137,
  HYPEREVM: 999,
  BSC: 56,
  INK: 57073,
} as const

export type ChainId = (typeof CHAIN_ID)[keyof typeof CHAIN_ID]

export const chains: Chain[] = [
  {
    id: 1,
    name: 'Ethereum',
    icon: CHAIN_ICONS[1],
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    nativeGasIsEth: true,
    cctpDomain: 0,
    usdt0Supported: true,
  },
  {
    id: 8453,
    name: 'Base',
    icon: CHAIN_ICONS[8453],
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    nativeGasIsEth: true,
    cctpDomain: 6,
  },
  {
    id: 42161,
    name: 'Arbitrum',
    icon: CHAIN_ICONS[42161],
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    nativeGasIsEth: true,
    cctpDomain: 3,
    usdt0Supported: true,
  },
  {
    id: 10,
    name: 'Optimism',
    icon: CHAIN_ICONS[10],
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    nativeGasIsEth: true,
    cctpDomain: 2,
    usdt0Supported: true,
  },
  {
    id: 137,
    name: 'Polygon',
    icon: CHAIN_ICONS[137],
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    cctpDomain: 7,
    usdt0Supported: true,
  },
  {
    id: 999,
    name: 'HyperEVM',
    icon: CHAIN_ICONS[999],
    rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
    explorerUrl: 'https://hyperevmscan.io',
    // HyperEVM native gas token is HYPE (~$31), NOT ETH.
    // There is no wrapped ETH on HyperEVM — bridging "ETH" would deliver HYPE.
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    cctpDomain: 19,
    usdt0Supported: true,
  },
  {
    id: 56,
    name: 'BNBChain',
    icon: CHAIN_ICONS[56],
    rpcUrl: 'https://bsc-rpc.publicnode.com',
    explorerUrl: 'https://bscscan.com',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  },
  {
    id: 57073,
    name: 'Ink',
    icon: CHAIN_ICONS[57073],
    rpcUrl: 'https://rpc-gel.inkonchain.com',
    explorerUrl: 'https://explorer.inkonchain.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    nativeGasIsEth: true,
    cctpDomain: 21,
    usdt0Supported: true,
  },
]

export const chainById = new Map(chains.map(c => [c.id, c]))

export const ethGasChainIds = new Set(chains.filter(c => c.nativeGasIsEth).map(c => c.id))

/** PublicNode RPCs — used by wagmi transport and RPC request dispatch. */
export const PUBLICNODE_RPC: Record<number, string> = {
  1:     'https://ethereum-rpc.publicnode.com',
  8453:  'https://base-rpc.publicnode.com',
  56:    'https://bsc-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  10:    'https://optimism-rpc.publicnode.com',
  137:   'https://polygon-bor-rpc.publicnode.com',
  999:   'https://rpc.hyperliquid.xyz/evm',
  57073: 'https://rpc-gel.inkonchain.com',
}

/**
 * Convert our app Chain → viem-shaped chain object for wagmi/viem usage.
 * Single source of truth — eliminates duplicate chain definitions in wallet files.
 */
function toViemChain(c: Chain) {
  return {
    id: c.id,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: [PUBLICNODE_RPC[c.id] ?? c.rpcUrl] } },
    blockExplorers: { default: { name: 'Explorer', url: c.explorerUrl } },
  } as const
}

export const viemChains = Object.fromEntries(
  chains.map(c => [c.id, toViemChain(c)])
) as Record<number, ReturnType<typeof toViemChain>>

export function isCCTPSupported(chainId: number): boolean {
  return chainById.get(chainId)?.cctpDomain !== undefined
}

export function isUSDT0Supported(chainId: number): boolean {
  return chainById.get(chainId)?.usdt0Supported === true
}

/** Chains where USDT is only available as USDT0 via OFT bridge (no native Circle USDT). */
const USDT0_OFT_ONLY_CHAINS = new Set<number>([CHAIN_ID.HYPEREVM, CHAIN_ID.INK])

export function isUSDT0OftChain(chainId: number): boolean {
  return USDT0_OFT_ONLY_CHAINS.has(chainId)
}

export function displayTokenSymbol(symbol: string, chainId: number): string {
  return symbol.toUpperCase() === 'USDT' && isUSDT0OftChain(chainId) ? 'USDT0' : symbol
}
