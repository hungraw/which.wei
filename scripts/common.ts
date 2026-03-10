import { readFileSync } from 'fs'
import { join } from 'path'
import { parseGwei, type Hex } from 'viem'

export const WEI_RESOLVER = '0x0000000000696760e15f265e828db644a0c242eb' as const
export const DOMAIN = 'which.wei'
export const MAX_FEE_PER_GAS = parseGwei('1')
export const MAX_PRIORITY_FEE = parseGwei('0.05')
export const ETH_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://eth.drpc.org',
]

export const RESOLVER_ABI = [
  {
    name: 'setContenthash',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'hash', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

// RFC 4648 base32 (lowercase, no padding) → Uint8Array
function base32Decode(input: string): Uint8Array {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const stripped = input.replace(/=+$/, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of stripped) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid base32 char: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// Convert CIDv1 base32 string (bafyb...) → EIP-1577 contenthash hex
export function cidToContenthash(cid: string): Hex {
  if (!cid.startsWith('bafy')) throw new Error('Expected CIDv1 base32 (bafyb...)')
  const raw = base32Decode(cid.slice(1))
  const contenthash = new Uint8Array([0xe3, 0x01, ...raw])
  return ('0x' + Buffer.from(contenthash).toString('hex')) as Hex
}

export function loadEnv() {
  const envPath = join(import.meta.dirname, '..', '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key && val) process.env[key] = val
  }
}
