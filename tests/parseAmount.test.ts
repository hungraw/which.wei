import { describe, it, expect } from 'vitest'
import { parseAmount } from '../src/utils/parse'

/**
 * Test the parseAmount function — converts human-readable amount strings
 * to raw BigInt strings without floating-point precision loss.
 *
 * Imports the REAL function from src/utils/parse.ts (no copy-paste).
 * This is CRITICAL: a bug here means users send wrong amounts to bridges.
 */

describe('parseAmount', () => {
  describe('6-decimal tokens (USDC, USDT)', () => {
    const D = 6

    it('1 USDC → 1000000 raw units', () => {
      expect(parseAmount('1', D)).toBe('1000000')
    })

    it('100 USDC → 100000000 raw units', () => {
      expect(parseAmount('100', D)).toBe('100000000')
    })

    it('0 → 0', () => {
      expect(parseAmount('0', D)).toBe('0')
    })

    it('1.5 USDC → 1500000', () => {
      expect(parseAmount('1.5', D)).toBe('1500000')
    })

    it('supports comma decimal: 1,5 USDC → 1500000', () => {
      expect(parseAmount('1,5', D)).toBe('1500000')
    })

    it('supports leading comma: ,5 USDC → 500000', () => {
      expect(parseAmount(',5', D)).toBe('500000')
    })

    it('supports mixed separators (US locale): 1,234.56 → 1234560000', () => {
      expect(parseAmount('1,234.56', D)).toBe('1234560000')
    })

    it('supports mixed separators (EU locale): 1.234,56 → 1234560000', () => {
      expect(parseAmount('1.234,56', D)).toBe('1234560000')
    })

    it('99.99 USDC → 99990000', () => {
      expect(parseAmount('99.99', D)).toBe('99990000')
    })

    it('dust: 0.000001 USDC → 1 (smallest unit)', () => {
      expect(parseAmount('0.000001', D)).toBe('1')
    })

    it('truncates 7th decimal (no rounding): 1.1234567 → 1123456', () => {
      expect(parseAmount('1.1234567', D)).toBe('1123456')
    })

    it('truncates (not rounds): 1.9999999 → 1999999', () => {
      expect(parseAmount('1.9999999', D)).toBe('1999999')
    })

    it('leading zeros in fraction: 1.001 → 1001000', () => {
      expect(parseAmount('1.001', D)).toBe('1001000')
    })

    it('exact smallest unit: 1.000001 → 1000001', () => {
      expect(parseAmount('1.000001', D)).toBe('1000001')
    })
  })

  describe('18-decimal tokens (ETH, BNB-chain USDC)', () => {
    const D = 18

    it('1 ETH → 1e18 wei', () => {
      expect(parseAmount('1', D)).toBe('1000000000000000000')
    })

    it('100 ETH → 1e20 wei', () => {
      expect(parseAmount('100', D)).toBe('100000000000000000000')
    })

    it('0.001 ETH → 1e15 wei', () => {
      expect(parseAmount('0.001', D)).toBe('1000000000000000')
    })

    it('smallest wei: 0.000000000000000001 → 1', () => {
      expect(parseAmount('0.000000000000000001', D)).toBe('1')
    })

    it('full precision: 1.123456789012345678 → exact', () => {
      expect(parseAmount('1.123456789012345678', D)).toBe('1123456789012345678')
    })

    it('PROVES floating-point trap: full-precision input differs from Number approach', () => {
      // Number('1.123456789012345678') loses the last 2 digits (only ~16 sig digits)
      // Math.round(Number('1.123456789012345678') * 1e18) → 1123456789012345700
      // parseAmount must give the exact                      1123456789012345678
      const correct = parseAmount('1.123456789012345678', D)
      expect(correct).toBe('1123456789012345678')

      const broken = BigInt(Math.round(Number('1.123456789012345678') * 1e18)).toString()
      expect(broken).not.toBe(correct) // This PROVES Number approach loses precision
    })
  })

  describe('edge cases', () => {
    it('trailing dot: "10." → 10000000', () => {
      expect(parseAmount('10.', 6)).toBe('10000000')
    })

    it('very large whole number: 999999 USDC', () => {
      expect(parseAmount('999999', 6)).toBe('999999000000')
    })

    it('50 with no fraction → 50000000', () => {
      expect(parseAmount('50', 6)).toBe('50000000')
    })
  })
})
