import { describe, it, expect } from 'vitest'
import { isCCTPSupported, isUSDT0Supported } from '../src/config/chains'
import { isStargateSupported } from '../src/providers/stargate'
import { isCbridgeSupported } from '../src/providers/cbridge'
import { isDebridgeSupported } from '../src/providers/debridge'
import { isEcoSupported } from '../src/providers/eco'
import { isSynapseSupported } from '../src/providers/synapse'
import { isOrbiterSupported } from '../src/providers/orbiter'

/**
 * Test all provider eligibility/support-check functions.
 *
 * These are the gatekeepers — they decide which providers get queried
 * for a given chain/token pair. A bug here means missing routes or
 * wasted API calls to unsupported providers.
 *
 * Uses REAL config data (no mocks). These are pure functions over
 * static chain/token maps — no network calls.
 */

// ─── CCTP (Circle's native USDC bridge) ─────────────────────────────

describe('isCCTPSupported', () => {
  const CCTP_CHAINS = [1, 8453, 42161, 10, 137, 999, 57073]

  for (const chainId of CCTP_CHAINS) {
    it(`chain ${chainId} → true`, () => {
      expect(isCCTPSupported(chainId)).toBe(true)
    })
  }

  it('BNB (56) → false (no CCTP)', () => {
    expect(isCCTPSupported(56)).toBe(false)
  })

  it('unknown chain → false', () => {
    expect(isCCTPSupported(99999)).toBe(false)
  })
})

// ─── USDT0 (LayerZero OFT bridge for USDT) ─────────────────────────

describe('isUSDT0Supported', () => {
  const USDT0_CHAINS = [1, 42161, 10, 137, 999, 57073]

  for (const chainId of USDT0_CHAINS) {
    it(`chain ${chainId} → true`, () => {
      expect(isUSDT0Supported(chainId)).toBe(true)
    })
  }

  it('Base (8453) → false', () => {
    expect(isUSDT0Supported(8453)).toBe(false)
  })

  it('BNB (56) → false', () => {
    expect(isUSDT0Supported(56)).toBe(false)
  })

  it('unknown chain → false', () => {
    expect(isUSDT0Supported(99999)).toBe(false)
  })
})

// ─── Stargate V2 (liquidity pool bridge) ────────────────────────────

describe('isStargateSupported', () => {
  it('USDC Ethereum → Base → true', () => {
    expect(isStargateSupported('USDC', 1, 8453)).toBe(true)
  })

  it('USDT Ethereum → Arbitrum → true', () => {
    expect(isStargateSupported('USDT', 1, 42161)).toBe(true)
  })

  it('ETH Ethereum → Base → true', () => {
    expect(isStargateSupported('ETH', 1, 8453)).toBe(true)
  })

  it('ETH on Polygon → false (no Polygon ETH pool)', () => {
    expect(isStargateSupported('ETH', 137, 1)).toBe(false)
  })

  it('ETH on BNB → false (no BNB ETH pool)', () => {
    expect(isStargateSupported('ETH', 56, 1)).toBe(false)
  })

  it('HyperEVM → false (not in Stargate CHAIN_KEY)', () => {
    expect(isStargateSupported('USDC', 999, 1)).toBe(false)
  })

  it('unknown token → false', () => {
    expect(isStargateSupported('DOGE', 1, 8453)).toBe(false)
  })

  it('unknown chain → false', () => {
    expect(isStargateSupported('USDC', 1, 99999)).toBe(false)
  })
})

// ─── cBridge (Celer pool-based bridge) ──────────────────────────────

describe('isCbridgeSupported', () => {
  it('USDT Ethereum → Arbitrum → true', () => {
    expect(isCbridgeSupported('USDT', 1, 42161)).toBe(true)
  })

  it('USDC Ethereum → BNB → true', () => {
    expect(isCbridgeSupported('USDC', 1, 56)).toBe(true)
  })

  it('USDC on Base → false (cBridge uses USDC.e, not native)', () => {
    expect(isCbridgeSupported('USDC', 8453, 1)).toBe(false)
  })

  it('ETH → false (cBridge needs WETH wrapping)', () => {
    expect(isCbridgeSupported('ETH', 1, 8453)).toBe(false)
  })

  it('HyperEVM → false (not in cBridge)', () => {
    expect(isCbridgeSupported('USDT', 999, 1)).toBe(false)
  })

  it('Ink → false (not in cBridge)', () => {
    expect(isCbridgeSupported('USDT', 57073, 1)).toBe(false)
  })
})

// ─── deBridge DLN (intent-based bridge) ─────────────────────────────

describe('isDebridgeSupported', () => {
  it('USDC Ethereum → Base → true', () => {
    expect(isDebridgeSupported('USDC', 1, 8453)).toBe(true)
  })

  it('USDT Polygon → Arbitrum → true', () => {
    expect(isDebridgeSupported('USDT', 137, 42161)).toBe(true)
  })

  it('ETH Ethereum → Optimism → true', () => {
    expect(isDebridgeSupported('ETH', 1, 10)).toBe(true)
  })

  it('HyperEVM → false (not supported)', () => {
    expect(isDebridgeSupported('USDC', 999, 1)).toBe(false)
  })

  it('Ink → false (not supported)', () => {
    expect(isDebridgeSupported('USDC', 57073, 1)).toBe(false)
  })

  it('unknown token → false', () => {
    expect(isDebridgeSupported('DOGE', 1, 8453)).toBe(false)
  })
})

// ─── Eco Routes (stablecoin-only intent bridge) ─────────────────────

describe('isEcoSupported', () => {
  it('USDC Ethereum → Base → true', () => {
    expect(isEcoSupported('USDC', 1, 8453)).toBe(true)
  })

  it('USDT Optimism → Ink → false (OP USDT is USDT0, not supported by Eco)', () => {
    expect(isEcoSupported('USDT', 10, 57073)).toBe(false)
  })

  it('USDT with Base → false (unsupported by Eco quote API)', () => {
    expect(isEcoSupported('USDT', 1, 8453)).toBe(false)
  })

  it('ETH → false (stablecoins only)', () => {
    expect(isEcoSupported('ETH', 1, 8453)).toBe(false)
  })

  it('HyperEVM → false (not in Eco)', () => {
    expect(isEcoSupported('USDC', 999, 1)).toBe(false)
  })

  it('BNB → false (not in Eco)', () => {
    expect(isEcoSupported('USDC', 56, 1)).toBe(false)
  })
})

// ─── Synapse Protocol ───────────────────────────────────────────────

describe('isSynapseSupported', () => {
  it('Ethereum → Base → true', () => {
    expect(isSynapseSupported(1, 8453)).toBe(true)
  })

  it('USDT with Base → false (unsupported token pair)', () => {
    expect(isSynapseSupported(1, 8453, 'USDT')).toBe(false)
  })

  it('Arbitrum → Polygon → true', () => {
    expect(isSynapseSupported(42161, 137)).toBe(true)
  })

  it('same chain → false', () => {
    expect(isSynapseSupported(1, 1)).toBe(false)
  })

  it('HyperEVM → false (not in Synapse)', () => {
    expect(isSynapseSupported(999, 1)).toBe(false)
  })

  it('Ink → false (not in Synapse)', () => {
    expect(isSynapseSupported(57073, 1)).toBe(false)
  })

  it('unknown chain → false', () => {
    expect(isSynapseSupported(99999, 1)).toBe(false)
  })
})

// ─── Orbiter Finance ────────────────────────────────────────────────

describe('isOrbiterSupported', () => {
  it('Ethereum → Base → true', () => {
    expect(isOrbiterSupported(1, 8453)).toBe(true)
  })

  it('Ink → Polygon → true', () => {
    expect(isOrbiterSupported(57073, 137)).toBe(true)
  })

  it('same chain → false', () => {
    expect(isOrbiterSupported(1, 1)).toBe(false)
  })

  it('HyperEVM → false (not in Orbiter)', () => {
    expect(isOrbiterSupported(999, 1)).toBe(false)
  })

  it('unknown chain → false', () => {
    expect(isOrbiterSupported(99999, 1)).toBe(false)
  })
})
