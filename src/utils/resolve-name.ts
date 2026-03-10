import { createPublicClient, http, namehash } from 'viem'
import { mainnet } from 'viem/chains'
import { PUBLICNODE_RPC } from '../config/chains'

export interface ResolvedRecipient {
  address: string
  name: string | undefined
  nameType: 'ens' | 'wns' | undefined
}

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const
const WNS_RESOLVER = '0x0000000000696760e15f265e828db644a0c242eb' as const

const RESOLVER_ABI = [{ name: 'resolver', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32', name: 'node' }], outputs: [{ type: 'address', name: '' }] }] as const
const ADDR_ABI = [{ name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32', name: 'node' }], outputs: [{ type: 'address', name: '' }] }] as const

let _mainnetClient: ReturnType<typeof createPublicClient> | null = null

function getMainnetClient() {
  if (!_mainnetClient) {
    const rpcUrl = PUBLICNODE_RPC[1] ?? 'https://ethereum-rpc.publicnode.com'
    _mainnetClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  }
  return _mainnetClient
}

export async function resolveRecipient(input: string): Promise<ResolvedRecipient> {
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    return { address: input, name: undefined, nameType: undefined }
  }

  if (/^.+\.eth$/i.test(input) && input.length > 4) {
    const address = await resolveENS(input)
    if (!address) throw new Error(`ENS name "${input}" does not resolve to an address`)
    return { address, name: input, nameType: 'ens' }
  }

  if (/^.+\.wei$/i.test(input) && input.length > 4) {
    const address = await resolveWNS(input)
    if (!address) throw new Error(`WNS name "${input}" does not resolve to an address`)
    return { address, name: input, nameType: 'wns' }
  }

  throw new Error(`Invalid recipient format: "${input}". Expected 0x address, name.eth, or name.wei`)
}

async function resolveENS(name: string): Promise<string | null> {
  try {
    const node = namehash(name)
    const resolver = await getMainnetClient().readContract({
      address: ENS_REGISTRY,
      abi: RESOLVER_ABI,
      functionName: 'resolver',
      args: [node],
    })
    if (!resolver || resolver === '0x0000000000000000000000000000000000000000') return null

    const addr = await getMainnetClient().readContract({
      address: resolver,
      abi: ADDR_ABI,
      functionName: 'addr',
      args: [node],
    })
    if (!addr || addr === '0x0000000000000000000000000000000000000000') return null
    return addr
  } catch {
    return null
  }
}

async function resolveWNS(name: string): Promise<string | null> {
  try {
    const node = namehash(name)
    const addr = await getMainnetClient().readContract({
      address: WNS_RESOLVER,
      abi: ADDR_ABI,
      functionName: 'addr',
      args: [node],
    })
    if (!addr || addr === '0x0000000000000000000000000000000000000000') return null
    return addr
  } catch {
    return null
  }
}


