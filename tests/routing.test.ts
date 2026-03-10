import { describe, it, expect } from 'vitest'
import { getTokenAddress, getTokenDecimals, tokensForChainPair, tokens } from '../src/config/tokens'
import { chains, isCCTPSupported, isUSDT0Supported } from '../src/config/chains'
import { anyProviderSupportsRoute } from '../src/core/router'

/**
 * Test route filtering logic — ensures the right providers are
 * activated for each token/chain combination.
 */

describe('Token/Chain Configuration', () => {
  describe('getTokenAddress', () => {
    it('returns USDC address on Ethereum', () => {
      expect(getTokenAddress('USDC', 1)).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
    })

    it('returns null for unsupported token/chain', () => {
      expect(getTokenAddress('USDC', 99999)).toBeNull()
      expect(getTokenAddress('DOGE', 1)).toBeNull()
    })

    it('returns native address for ETH on L2s', () => {
      const native = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
      expect(getTokenAddress('ETH', 8453)).toBe(native) // Base
      expect(getTokenAddress('ETH', 42161)).toBe(native) // Arbitrum
      expect(getTokenAddress('ETH', 10)).toBe(native) // Optimism
    })

    it('returns WETH on Polygon (not native)', () => {
      expect(getTokenAddress('ETH', 137)).toBe('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619')
    })

    it('ETH not available on BNB Chain', () => {
      expect(getTokenAddress('ETH', 56)).toBeNull()
    })

    it('ETH not available on HyperEVM (native is HYPE)', () => {
      expect(getTokenAddress('ETH', 999)).toBeNull()
    })
  })

  describe('getTokenDecimals', () => {
    it('USDC is 6 decimals on most chains', () => {
      expect(getTokenDecimals('USDC', 1)).toBe(6)
      expect(getTokenDecimals('USDC', 8453)).toBe(6)
      expect(getTokenDecimals('USDC', 42161)).toBe(6)
    })

    it('USDC is 18 decimals on BNB Chain (Binance-Peg)', () => {
      expect(getTokenDecimals('USDC', 56)).toBe(18)
    })

    it('USDT is 18 decimals on BNB Chain', () => {
      expect(getTokenDecimals('USDT', 56)).toBe(18)
    })

    it('ETH is 18 decimals everywhere', () => {
      expect(getTokenDecimals('ETH', 1)).toBe(18)
      expect(getTokenDecimals('ETH', 8453)).toBe(18)
    })
  })

  describe('tokensForChainPair', () => {
    it('Ethereum → Base: USDC, USDT, ETH', () => {
      const result = tokensForChainPair(1, 8453)
      const symbols = result.map(t => t.symbol).sort()
      expect(symbols).toEqual(['ETH', 'USDC', 'USDT'])
    })

    it('Ethereum → BNB Chain: USDC, USDT (no ETH)', () => {
      const result = tokensForChainPair(1, 56)
      const symbols = result.map(t => t.symbol).sort()
      expect(symbols).toEqual(['USDC', 'USDT'])
    })

    it('HyperEVM → Ink: USDC, USDT0 (no ETH — HyperEVM native is HYPE)', () => {
      const result = tokensForChainPair(999, 57073)
      const symbols = result.map(t => t.symbol).sort()
      expect(symbols).toEqual(['USDC', 'USDT0'])
    })
  })
})

describe('Chain Configuration', () => {
  describe('CCTP support', () => {
    it('supported on all chains except BNB', () => {
      expect(isCCTPSupported(1)).toBe(true)     // Ethereum
      expect(isCCTPSupported(8453)).toBe(true)   // Base
      expect(isCCTPSupported(42161)).toBe(true)  // Arbitrum
      expect(isCCTPSupported(10)).toBe(true)     // Optimism
      expect(isCCTPSupported(137)).toBe(true)    // Polygon
      expect(isCCTPSupported(999)).toBe(true)    // HyperEVM
      expect(isCCTPSupported(57073)).toBe(true)  // Ink
      expect(isCCTPSupported(56)).toBe(false)    // BNB — no CCTP
    })
  })

  describe('USDT0 support', () => {
    it('supported on chains with USDT0 deployments', () => {
      expect(isUSDT0Supported(1)).toBe(true)       // Ethereum (OFT Adapter)
      expect(isUSDT0Supported(42161)).toBe(true)   // Arbitrum
      expect(isUSDT0Supported(10)).toBe(true)      // Optimism
      expect(isUSDT0Supported(137)).toBe(true)     // Polygon
      expect(isUSDT0Supported(999)).toBe(true)     // HyperEVM
      expect(isUSDT0Supported(57073)).toBe(true)   // Ink
    })

    it('not supported on BNB or Base', () => {
      expect(isUSDT0Supported(56)).toBe(false)
      expect(isUSDT0Supported(8453)).toBe(false)
    })

  })

  describe('all chains have required fields', () => {
    for (const chain of chains) {
      it(`${chain.name} (${chain.id}) has complete config`, () => {
        expect(chain.rpcUrl).toBeTruthy()
        expect(chain.explorerUrl).toBeTruthy()
        expect(chain.nativeCurrency.decimals).toBe(18)
        expect(chain.icon).toBeTruthy()
      })
    }
  })
})

describe('Route Existence Pre-check', () => {
  it('filters USDT routes from USDT0-only chains', () => {
    // HyperEVM/Ink “USDT” is the USDT0-native token. Allow destinations only when USDT0 exists on both ends.
    expect(anyProviderSupportsRoute('USDT', 999, 8453)).toBe(false)   // HyperEVM → Base (no USDT0 on Base)
    expect(anyProviderSupportsRoute('USDT', 999, 1)).toBe(true)       // HyperEVM → Ethereum (USDT0 via adapter)
    expect(anyProviderSupportsRoute('USDT', 999, 57073)).toBe(true)   // HyperEVM → Ink
    expect(anyProviderSupportsRoute('USDT', 57073, 999)).toBe(true)
    expect(anyProviderSupportsRoute('USDT', 57073, 42161)).toBe(true) // Ink → Arbitrum
  })

  it('allows USDC HyperEVM routes (CCTP-capable)', () => {
    expect(anyProviderSupportsRoute('USDC', 999, 1)).toBe(true)
    expect(anyProviderSupportsRoute('USDC', 999, 8453)).toBe(true)
  })

  it('rejects tokens not present on chain', () => {
    expect(anyProviderSupportsRoute('ETH', 56, 1)).toBe(false) // no ETH token on BNB in our config
    expect(anyProviderSupportsRoute('ETH', 999, 1)).toBe(false) // no ETH on HyperEVM
  })
})
