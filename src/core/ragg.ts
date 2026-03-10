import { encodeFunctionData } from 'viem'

// Same on all chains via CREATE2
export const RAGG_ADDRESS = '0x85d5b2202b2c79867048C1D6C8345933B506EE96'

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

// Use classic approve() on chains not in this set
export const PERMIT2_CHAINS = new Set([1, 8453, 42161, 10, 137, 56])

export const REF_UI = '0x77686963682e7765692d756900000000' as `0x${string}` // "which.wei-ui"
export const REF_AGENT = '0x77686963682e7765692d616774000000' as `0x${string}` // "which.wei-agt"

export const RAGG_PROVIDERS = new Set([
  'Across',
  'CCTP Fast',
  'CCTP Slow',
  'USDT0',
  'deBridge',
  'Eco',
  'Gas.zip',
  'Stargate Taxi',
  'Stargate Bus',
  'cBridge',
  'Synapse',
  'Orbiter',
  'Mayan Swift',
  'Mayan MCTP',
  'Mayan WH',
  'Relay',
])

const RAGG_ABI = [
  {
    name: 'bridgeERC20',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'bridgeCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'bridgeNative',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'bridgeCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'bridgeERC20Permit2',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'bridgeCalldata', type: 'bytes' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
      { name: 'ref', type: 'bytes16' },
    ],
    outputs: [],
  },
  {
    name: 'bridgeERC20Ref',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'bridgeCalldata', type: 'bytes' },
      { name: 'ref', type: 'bytes16' },
    ],
    outputs: [],
  },
  {
    name: 'bridgeNativeRef',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'destChainId', type: 'uint256' },
      { name: 'bridgeCalldata', type: 'bytes' },
      { name: 'ref', type: 'bytes16' },
    ],
    outputs: [],
  },
] as const

// 1 tx, no prior rAgg approval needed
export function wrapERC20Permit2(
  target: string,
  token: string,
  amount: bigint,
  destChainId: number,
  bridgeCalldata: string,
  nonce: bigint,
  deadline: bigint,
  signature: string,
  ref: `0x${string}` = REF_UI,
  nativeValue: bigint = 0n,
): { to: `0x${string}`; data: `0x${string}`; value: string } {
  return {
    to: RAGG_ADDRESS as `0x${string}`,
    data: encodeFunctionData({
      abi: RAGG_ABI,
      functionName: 'bridgeERC20Permit2',
      args: [
        target as `0x${string}`,
        token as `0x${string}`,
        amount,
        BigInt(destChainId),
        bridgeCalldata as `0x${string}`,
        nonce,
        deadline,
        signature as `0x${string}`,
        ref,
      ],
    }),
    value: nativeValue.toString(),
  }
}

export function wrapERC20Ref(
  target: string,
  token: string,
  amount: bigint,
  destChainId: number,
  bridgeCalldata: string,
  ref: `0x${string}` = REF_UI,
  nativeValue: bigint = 0n,
): { to: `0x${string}`; data: `0x${string}`; value: string } {
  return {
    to: RAGG_ADDRESS as `0x${string}`,
    data: encodeFunctionData({
      abi: RAGG_ABI,
      functionName: 'bridgeERC20Ref',
      args: [
        target as `0x${string}`,
        token as `0x${string}`,
        amount,
        BigInt(destChainId),
        bridgeCalldata as `0x${string}`,
        ref,
      ],
    }),
    value: nativeValue.toString(),
  }
}

export function wrapNativeRef(
  target: string,
  destChainId: number,
  bridgeCalldata: string,
  value: bigint,
  ref: `0x${string}` = REF_UI,
): { to: `0x${string}`; data: `0x${string}`; value: string } {
  return {
    to: RAGG_ADDRESS as `0x${string}`,
    data: encodeFunctionData({
      abi: RAGG_ABI,
      functionName: 'bridgeNativeRef',
      args: [
        target as `0x${string}`,
        BigInt(destChainId),
        bridgeCalldata as `0x${string}`,
        ref,
      ],
    }),
    value: value.toString(),
  }
}
