import { describe, it, expect } from 'vitest'
import {
  formatUSD,
  formatToken,
  formatTime,
  truncateAddress,
  explorerTxUrl,
} from '../src/utils/format'

/**
 * Test formatting utilities — these render directly in the UI.
 * Wrong formatting = wrong user decisions.
 */

describe('formatUSD', () => {
  it('$1.50', () => expect(formatUSD(1.5)).toBe('$1.50'))
  it('$0.03', () => expect(formatUSD(0.03)).toBe('$0.03'))
  it('$100.00', () => expect(formatUSD(100)).toBe('$100.00'))
  it('$0.00', () => expect(formatUSD(0)).toBe('$0.00'))
  it('$1,234.56 (commas)', () => expect(formatUSD(1234.56)).toBe('$1,234.56'))
  it('values below $0.01 show "<$0.01" ($0.005)', () => expect(formatUSD(0.005)).toBe('<$0.01'))
  it('values below $0.01 show "<$0.01" ($0.004)', () => expect(formatUSD(0.004)).toBe('<$0.01'))
})

describe('formatToken', () => {
  it('50 USDC (6 dec) → "50"', () => expect(formatToken('50000000', 6)).toBe('50'))
  it('1.5 USDC → "1.5"', () => expect(formatToken('1500000', 6, 2)).toBe('1.5'))
  it('1 ETH (18 dec) → "1"', () => expect(formatToken('1000000000000000000', 18)).toBe('1'))
  it('0.1 ETH → "0.1"', () => expect(formatToken('100000000000000000', 18)).toBe('0.1'))
  it('0 amount → "0"', () => expect(formatToken('0', 6)).toBe('0'))
  it('dust (1 wei of 18 dec) → "<0.000001"', () => expect(formatToken('1', 18)).toBe('<0.000001'))
  it('maxDecimals=2 limits output', () => {
    // 1.123456 USDC → should show at most 2 decimals
    expect(formatToken('1123456', 6, 2)).toBe('1.12')
  })
})

describe('formatTime', () => {
  it('30s → "~30s"', () => expect(formatTime(30)).toBe('~30s'))
  it('15s → "~15s"', () => expect(formatTime(15)).toBe('~15s'))
  it('60s → "~1m"', () => expect(formatTime(60)).toBe('~1m'))
  it('120s → "~2m"', () => expect(formatTime(120)).toBe('~2m'))
  it('300s → "~5m"', () => expect(formatTime(300)).toBe('~5m'))
  it('0s → "~0s"', () => expect(formatTime(0)).toBe('~0s'))
  it('59s → "~59s" (boundary)', () => expect(formatTime(59)).toBe('~59s'))
  it('3600s → "~60m"', () => expect(formatTime(3600)).toBe('~60m'))
  it('fractional seconds rounded: 29.7 → "~30s"', () => expect(formatTime(29.7)).toBe('~30s'))
})

describe('truncateAddress', () => {
  it('valid 42-char address → 0x1234…5678', () => {
    expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678'))
      .toBe('0x1234…5678')
  })

  it('invalid address → returned as-is', () => {
    expect(truncateAddress('not-an-address')).toBe('not-an-address')
  })

  it('empty string → returned as-is', () => {
    expect(truncateAddress('')).toBe('')
  })

  it('too-short hex → returned as-is', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234')
  })

  it('checksummed address still truncates', () => {
    expect(truncateAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'))
      .toBe('0xd8dA…6045')
  })

  it('no 0x prefix → returned as-is (fails regex)', () => {
    expect(truncateAddress('1234567890abcdef1234567890abcdef12345678'))
      .toBe('1234567890abcdef1234567890abcdef12345678')
  })
})

describe('explorerTxUrl', () => {
  const HASH = '0x' + 'a'.repeat(64)

  it('builds valid tx URL', () => {
    expect(explorerTxUrl('https://etherscan.io', HASH)).toBe(`https://etherscan.io/tx/${HASH}`)
  })

  it('strips single trailing slash', () => {
    expect(explorerTxUrl('https://etherscan.io/', HASH)).toBe(`https://etherscan.io/tx/${HASH}`)
  })

  it('strips multiple trailing slashes', () => {
    expect(explorerTxUrl('https://etherscan.io///', HASH)).toBe(`https://etherscan.io/tx/${HASH}`)
  })

  it('rejects short hash', () => {
    expect(explorerTxUrl('https://etherscan.io', '0xinvalid')).toBeNull()
  })

  it('rejects empty hash', () => {
    expect(explorerTxUrl('https://etherscan.io', '')).toBeNull()
  })
})
