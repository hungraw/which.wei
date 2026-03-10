import {
  sendTransaction as wagmiSend,
  waitForTransactionReceipt,
  simulateContract,
  writeContract,
  readContract,
  getAccount,
  signTypedData,
} from '@wagmi/core'
import type { TxData } from '../core/types'
import { isKnownContract } from '../config/providers'
import { CHAIN_ID, type ChainId } from '../config/chains'
import { getWagmiConfig } from './connect'

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

export async function sendTransaction(tx: TxData): Promise<string> {
  const config = getWagmiConfig()
  const hash = await wagmiSend(config, {
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value || '0'),
    ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
  })
  return hash
}

export async function waitForReceipt(txHash: string, chainId?: number): Promise<void> {
  const config = getWagmiConfig()
  const confirmations = chainId === CHAIN_ID.ETHEREUM ? 2 : 1
  await waitForTransactionReceipt(config, {
    hash: txHash as `0x${string}`,
    confirmations,
  })
}

// Exact-amount approval only — never MAX_UINT
export async function approveToken(
  token: string,
  spender: string,
  amount: bigint,
  chainId?: number,
): Promise<string> {
  const config = getWagmiConfig()

  const account = getAccount(config)
  if (!account.address) throw new Error('Wallet not connected')
  const txChainId = chainId ?? account.chainId
  if (!txChainId) throw new Error('Missing chain for approval')
  const wagmiChainId = txChainId as ChainId

  const currentAllowance = await readContract(config, {
    chainId: wagmiChainId,
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, spender as `0x${string}`],
  })

  if (currentAllowance >= amount) return '' // already approved

  // USDT requires approve(0) before setting a new non-zero allowance.
  // Without this, USDT's approve() reverts with "SafeERC20: approve from non-zero to non-zero".
  if (currentAllowance > 0n) {
    await writeContract(config, {
      chainId: wagmiChainId,
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as `0x${string}`, 0n],
    })
  }

  await simulateContract(config, {
    chainId: wagmiChainId,
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender as `0x${string}`, amount],
  })

  const hash = await writeContract(config, {
    chainId: wagmiChainId,
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender as `0x${string}`, amount],
  })

  await waitForReceipt(hash, txChainId)
  return hash
}

export function validateCalldata(chainId: number, to: string): boolean {
  if (!isKnownContract(chainId, to)) {
    console.error(`[tx] unknown contract: ${to} on chain ${chainId}`)
    return false
  }
  return true
}

export const APPROVE_SELECTOR = '0x095ea7b3' // ERC20 approve(address,uint256)

/**
 * Validate an ERC-20 approve step:
 * 1. Calldata must start with the approve(address,uint256) selector
 * 2. Target (`to`) must match the expected token contract
 * 3. Spender (first ABI arg) must be on our known-contract allowlist
 *
 * Returns the extracted spender address on success, or null on failure.
 */
export function validateApproveStep(
  calldata: string,
  target: string,
  expectedToken: string | null,
  chainId: number,
  tag: string,
): string | null {
  if (!calldata.toLowerCase().startsWith(APPROVE_SELECTOR)) {
    console.error(`[${tag}] approve step has unexpected calldata selector:`, calldata.slice(0, 10))
    return null
  }
  if (expectedToken && target.toLowerCase() !== expectedToken.toLowerCase()) {
    console.error(`[${tag}] approve target mismatch: expected`, expectedToken, 'got', target)
    return null
  }
  const spenderHex = '0x' + calldata.slice(10 + 24, 10 + 64)
  if (!validateCalldata(chainId, spenderHex)) {
    console.error(`[${tag}] approve spender not in allowlist:`, spenderHex)
    return null
  }
  return spenderHex
}

/**
 * Verify that the user's address appears in ABI-encoded calldata.
 * Addresses are left-padded to 32 bytes in ABI encoding, so we check
 * for the 0-padded form. This catches a compromised API that replaces
 * the recipient with an attacker address.
 */
export function verifyCalldataRecipient(
  calldata: string,
  userAddress: string,
): boolean {
  if (!calldata || !userAddress) return false

  const addr = userAddress.toLowerCase().replace(/^0x/, '')
  if (addr.length !== 40) return false

  const dataLower = calldata.toLowerCase().replace(/^0x/, '')

  // ABI-encoded address = 12 bytes zero-padding + 20-byte address
  const padded = addr.padStart(64, '0')

  // Some providers pack addresses (20-byte) rather than full ABI-encoding.
  return dataLower.includes(padded) || dataLower.includes(addr)
}

/*//////////////////////////////////////////////////////////////
                           PERMIT2
//////////////////////////////////////////////////////////////*/

const PERMIT2_DOMAIN = {
  name: 'Permit2',
  verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`,
} as const

const PERMIT2_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const

/** Sign a Permit2 SignatureTransfer for the given token and amount.
 *  Returns nonce, deadline, and the EIP-712 signature. */
export async function signPermit2Transfer(
  token: string,
  amount: bigint,
  spender: string,
  chainId: number,
): Promise<{ nonce: bigint; deadline: bigint; signature: `0x${string}` }> {
  const config = getWagmiConfig()
  const nonce = BigInt(Date.now())
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800) // 30 minutes

  const signature = await signTypedData(config, {
    domain: { ...PERMIT2_DOMAIN, chainId },
    types: PERMIT2_TYPES,
    primaryType: 'PermitTransferFrom',
    message: {
      permitted: { token: token as `0x${string}`, amount },
      spender: spender as `0x${string}`,
      nonce,
      deadline,
    },
  })

  return { nonce, deadline, signature }
}

/** Ensure the user has approved the Permit2 contract for a token (one-time, max approval). */
export async function ensurePermit2Approval(
  token: string,
  chainId: number,
): Promise<string> {
  const config = getWagmiConfig()
  const account = getAccount(config)
  if (!account.address) throw new Error('Wallet not connected')

  const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`
  const wagmiChainId = chainId as ChainId

  const currentAllowance = await readContract(config, {
    chainId: wagmiChainId,
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, permit2],
  })

  // Permit2 uses max approval — check if already high enough
  if (currentAllowance >= 2n ** 200n) return ''

  // USDT: reset to 0 first
  if (currentAllowance > 0n) {
    await writeContract(config, {
      chainId: wagmiChainId,
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [permit2, 0n],
    })
  }

  const maxApproval = 2n ** 256n - 1n

  await simulateContract(config, {
    chainId: wagmiChainId,
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [permit2, maxApproval],
  })

  const hash = await writeContract(config, {
    chainId: wagmiChainId,
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [permit2, maxApproval],
  })

  await waitForReceipt(hash, chainId)
  return hash
}
