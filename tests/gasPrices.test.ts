import { describe, it, expect } from 'vitest'
import { fallbackGasCostUSD } from '../src/utils/gas'

/**
 * Test gas estimation and price utilities.
 *
 * fallbackGasCostUSD is a pure function (no mocks needed).
 * estimateGasCostUSD requires RPC mocking — tested via isolated imports.
 */

// ─── fallbackGasCostUSD (pure function) ──────────────────────────────

describe('fallbackGasCostUSD', () => {
  it('Ethereum (1) → $0.15', () => {
    expect(fallbackGasCostUSD(1)).toBe(0.15)
  })

  it('Base (8453) → $0.01', () => {
    expect(fallbackGasCostUSD(8453)).toBe(0.01)
  })

  it('Arbitrum (42161) → $0.01', () => {
    expect(fallbackGasCostUSD(42161)).toBe(0.01)
  })

  it('Optimism (10) → $0.01', () => {
    expect(fallbackGasCostUSD(10)).toBe(0.01)
  })

  it('Ink (57073) → $0.01', () => {
    expect(fallbackGasCostUSD(57073)).toBe(0.01)
  })

  it('Polygon (137) → $0.15', () => {
    expect(fallbackGasCostUSD(137)).toBe(0.15)
  })

  it('BNB (56) → $0.15', () => {
    expect(fallbackGasCostUSD(56)).toBe(0.15)
  })

  it('HyperEVM (999) → $0.01', () => {
    expect(fallbackGasCostUSD(999)).toBe(0.01)
  })

  it('unknown chain → $0.15 (safe overestimate)', () => {
    expect(fallbackGasCostUSD(99999)).toBe(0.15)
  })
})
