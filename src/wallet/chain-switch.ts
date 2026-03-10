import { switchChain as wagmiSwitch, getAccount } from '@wagmi/core'
import { getWagmiConfig } from './connect'

export async function switchChain(chainId: number): Promise<boolean> {
  try {
    const config = getWagmiConfig()
    const account = getAccount(config)

    if (account.chainId === chainId) return true

    await wagmiSwitch(config, { chainId: chainId as 1 })
    return true
  } catch (err) {
    console.warn('[wallet] chain switch failed:', err)
    return false
  }
}

export function isOnChain(chainId: number): boolean {
  const config = getWagmiConfig()
  const account = getAccount(config)
  return account.chainId === chainId
}
