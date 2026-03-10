import { createConfig, http, connect as wagmiConnect, disconnect as wagmiDisconnect, getAccount as wagmiGetAccount, watchAccount, injected } from '@wagmi/core'
import { mainnet, arbitrum, optimism, base, polygon, bsc } from 'viem/chains'
import { PUBLICNODE_RPC, viemChains, CHAIN_ID } from '../config/chains'

const CHAINS = [mainnet, base, bsc, arbitrum, optimism, polygon, viemChains[CHAIN_ID.HYPEREVM], viemChains[CHAIN_ID.INK]] as const
const IS_BROWSER = typeof window !== 'undefined'

const config = createConfig({
  chains: CHAINS,
  transports: {
    [mainnet.id]: http(PUBLICNODE_RPC[mainnet.id]),
    [base.id]: http(PUBLICNODE_RPC[base.id]),
    [bsc.id]: http(PUBLICNODE_RPC[bsc.id]),
    [arbitrum.id]: http(PUBLICNODE_RPC[arbitrum.id]),
    [optimism.id]: http(PUBLICNODE_RPC[optimism.id]),
    [polygon.id]: http(PUBLICNODE_RPC[polygon.id]),
    [viemChains[CHAIN_ID.HYPEREVM].id]: http(PUBLICNODE_RPC[viemChains[CHAIN_ID.HYPEREVM].id]),
    [viemChains[CHAIN_ID.INK].id]: http(PUBLICNODE_RPC[viemChains[CHAIN_ID.INK].id]),
  },
  connectors: IS_BROWSER ? [injected()] : [],
})

type AccountListener = (state: { address?: string; isConnected: boolean }) => void
let accountListeners: AccountListener[] = []

// Watch for account changes and notify listeners
watchAccount(config, {
  onChange(account) {
    const state = {
      address: account.address,
      isConnected: account.isConnected,
    }
    accountListeners.forEach(cb => cb(state))
  },
})

// wagmi/core auto-reconnects via persisted connector state — no init needed.

export async function openConnectModal() {
  try {
    await wagmiConnect(config, { connector: injected() })
  } catch (err) {
    console.error('[wallet] connect error:', err)
  }
}

export async function disconnect() {
  try {
    await wagmiDisconnect(config)
  } catch (err) {
    console.error('[wallet] disconnect error:', err)
  }
}

export function isConnected(): boolean {
  return wagmiGetAccount(config).isConnected
}

export function getAddress(): string | null {
  return wagmiGetAccount(config).address ?? null
}

export function subscribeAccount(cb: AccountListener) {
  accountListeners.push(cb)
  // Fire immediately with current state
  const account = wagmiGetAccount(config)
  cb({ address: account.address, isConnected: account.isConnected })
  return () => {
    accountListeners = accountListeners.filter(c => c !== cb)
  }
}

export function getWagmiConfig() {
  return config
}
