import { rpcRequest } from './rpc'
import { NATIVE } from '../config/tokens'

const BALANCE_OF_SELECTOR = '0x70a08231'

function hexToBigInt(hex: string): bigint {
  if (!hex) return 0n
  const h = hex.startsWith('0x') ? hex : `0x${hex}`
  return BigInt(h)
}

function encodeBalanceOf(userAddress: string): string {
  const addr = userAddress.toLowerCase().replace(/^0x/, '')
  // ABI encoding: selector + 32-byte left-padded address
  return `${BALANCE_OF_SELECTOR}${addr.padStart(64, '0')}`
}

export async function getTokenBalance(
  chainId: number,
  tokenAddress: string,
  userAddress: string,
): Promise<bigint> {
  if (tokenAddress.toLowerCase() === NATIVE.toLowerCase()) {
    const result = await rpcRequest<string>(chainId, 'eth_getBalance', [userAddress, 'latest'])
    return hexToBigInt(result)
  }

  const data = encodeBalanceOf(userAddress)
  const result = await rpcRequest<string>(chainId, 'eth_call', [{ to: tokenAddress, data }, 'latest'])
  return hexToBigInt(result)
}
