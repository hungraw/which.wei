import { formatUnits } from 'viem'

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function formatUSD(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatUSDFee(value: number): string {
  const normalized = value > 0 && value < 0.01 ? 0.01 : value
  return normalized.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatToken(amount: string, decimals: number, maxDecimals = 6): string {
  let raw: bigint
  try {
    raw = BigInt(amount)
  } catch {
    return amount
  }

  const asStr = formatUnits(raw, decimals)
  const num = Number(asStr)
  if (!Number.isFinite(num)) return asStr
  if (num === 0) return '0'
  if (num < 0.000001) return '<0.000001'
  return num.toLocaleString('en-US', { maximumFractionDigits: maxDecimals })
}

export function formatTime(seconds: number): string {
  if (seconds < 60) return `~${Math.round(seconds)}s`
  const mins = Math.round(seconds / 60)
  return `~${mins}m`
}

export function truncateAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function explorerTxUrl(explorerUrl: string, txHash: string): string | null {
  if (!TX_HASH_RE.test(txHash)) return null
  const base = explorerUrl.replace(/\/+$/, '')
  return `${base}/tx/${txHash}`
}
