/**
 * Parse a human-readable amount string to raw units (bigint string)
 * without floating-point precision loss.
 *
 * This is CRITICAL: a bug here means users send wrong amounts to bridges.
 *
 * Example: parseAmount('99.99', 6) → '99990000'
 */
import { parseUnits } from 'viem'

export function normalizeHumanAmountInput(human: string): string {
  const filtered = human.trim().replace(/[^0-9.,]/g, '')
  if (!filtered) return ''

  const lastDot = filtered.lastIndexOf('.')
  const lastComma = filtered.lastIndexOf(',')
  const lastSep = Math.max(lastDot, lastComma)

  // No separators — digits only.
  if (lastSep === -1) return filtered

  const before = filtered.slice(0, lastSep).replace(/[.,]/g, '')
  const after = filtered.slice(lastSep + 1).replace(/[.,]/g, '')
  const whole = before === '' ? '0' : before

  // Preserve a trailing decimal separator while typing (e.g. "1," → "1.").
  if (lastSep === filtered.length - 1) return `${whole}.`

  return `${whole}.${after}`
}

export function parseAmount(human: string, decimals: number): string {
  const raw = human.trim()

  // Never allow signed amounts.
  if (/[+-]/.test(raw)) throw new Error('Invalid amount')

  // Reject alphabetic chars (e.g. "1 ETH", "one", "1e-7").
  if (/[a-z]/i.test(raw)) throw new Error('Invalid amount')

  const s = normalizeHumanAmountInput(raw)

  // Reject exponent notation and obviously-invalid inputs early.
  // (String(number) can produce "1e-7" which must not reach BigInt parsing.)
  if (!s || /e/i.test(raw)) throw new Error('Invalid amount')

  // Allow only digits and at most one dot.
  // Accept leading dot (".5") by treating it as "0.5".
  if (!/^\d*(?:\.\d*)?$/.test(s)) throw new Error('Invalid amount')

  const [rawWhole = '', rawFrac = ''] = s.split('.')
  const whole = rawWhole === '' ? '0' : rawWhole

  // Truncate extra fractional precision (matches previous behavior).
  const frac = rawFrac.slice(0, Math.max(0, decimals))
  const normalized = frac.length ? `${whole}.${frac}` : whole

  return parseUnits(normalized, decimals).toString()
}
