import { describe, it, expect } from 'vitest'
import { isKnownContract, KNOWN_CONTRACTS } from '../src/config/providers'

/**
 * Test the contract allowlist — the primary defense against
 * API supply-chain attacks. Every bridge transaction's `tx.to`
 * is checked against this list before the user signs.
 */

describe('isKnownContract', () => {
  describe('case-insensitive matching', () => {
    it('matches exact case', () => {
      expect(isKnownContract(1, '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5')).toBe(true)
    })

    it('matches lowercase', () => {
      expect(isKnownContract(1, '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5')).toBe(true)
    })

    it('matches uppercase', () => {
      expect(isKnownContract(1, '0x5C7BCD6E7DE5423A257D81B442095A1A6CED35C5')).toBe(true)
    })
  })

  describe('rejects unknown contracts', () => {
    it('rejects random address', () => {
      expect(isKnownContract(1, '0xdead000000000000000000000000000000000000')).toBe(false)
    })

    it('rejects empty address', () => {
      expect(isKnownContract(1, '')).toBe(false)
    })

    it('rejects zero address', () => {
      expect(isKnownContract(1, '0x0000000000000000000000000000000000000000')).toBe(false)
    })
  })

  describe('chain isolation', () => {
    it('rejects valid contract on wrong chain', () => {
      // Across SpokePool on Ethereum
      const ethSpokePool = '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
      expect(isKnownContract(1, ethSpokePool)).toBe(true) // Ethereum ✓
      expect(isKnownContract(8453, ethSpokePool)).toBe(false) // Base has different SpokePool
    })

    it('rejects unsupported chain', () => {
      expect(isKnownContract(12345, '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5')).toBe(false)
    })
  })

  describe('all supported chains have entries', () => {
    const CHAIN_IDS = [1, 8453, 42161, 10, 137, 999, 56, 57073]

    for (const chainId of CHAIN_IDS) {
      it(`chain ${chainId} has at least one known contract`, () => {
        const set = KNOWN_CONTRACTS[chainId]
        expect(set).toBeDefined()
        expect(set.size).toBeGreaterThan(0)
      })
    }
  })

  describe('cross-chain contract addresses', () => {
    it('CCTP TokenMessengerV2 is same on all supported chains (CREATE2)', () => {
      const cctp = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
      // All chains except BNB (56) support CCTP
      for (const chainId of [1, 8453, 42161, 10, 137, 999, 57073]) {
        expect(isKnownContract(chainId, cctp)).toBe(true)
      }
      // BNB does NOT have CCTP
      expect(isKnownContract(56, cctp)).toBe(false)
    })

    it('Gas.zip deposit address is same on all chains', () => {
      const gaszip = '0x391E7C679d29bD940d63be94AD22A25d25b5A604'
      for (const chainId of [1, 8453, 42161, 10, 137, 999, 56, 57073]) {
        expect(isKnownContract(chainId, gaszip)).toBe(true)
      }
    })
  })
})
