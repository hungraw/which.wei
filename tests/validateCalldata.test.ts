import { describe, it, expect, vi } from 'vitest'

/**
 * Test validateCalldata (contract allowlist check).
 * validateCalldata delegates to isKnownContract — we mock config/providers
 * to isolate the wrapper logic.
 *
 * verifyCalldataRecipient tests live in calldataRecipient.test.ts.
 */

// Mock wagmi + connect to prevent initialization side-effects
vi.mock('@wagmi/core', () => ({
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  simulateContract: vi.fn(),
  writeContract: vi.fn(),
  readContract: vi.fn(),
  getAccount: vi.fn(),
}))

vi.mock('../src/wallet/connect', () => ({
  getWagmiConfig: vi.fn(() => ({})),
}))

import { validateCalldata } from '../src/wallet/transactions'
import { isKnownContract } from '../src/config/providers'

// ─── validateCalldata ───────────────────────────────────────────────

describe('validateCalldata', () => {
  it('returns true for known Across SpokePool on Ethereum', () => {
    expect(validateCalldata(1, '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5')).toBe(true)
  })

  it('returns true for CCTP TokenMessengerV2 on Base', () => {
    expect(validateCalldata(8453, '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d')).toBe(true)
  })

  it('returns true for Gas.zip on BNB', () => {
    expect(validateCalldata(56, '0x391E7C679d29bD940d63be94AD22A25d25b5A604')).toBe(true)
  })

  it('returns false + logs error for unknown contract', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(validateCalldata(1, '0xdead000000000000000000000000000000000000')).toBe(false)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown contract'))
    spy.mockRestore()
  })

  it('returns false for wrong chain (Eth SpokePool called on Base)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(validateCalldata(8453, '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5')).toBe(false)
    spy.mockRestore()
  })

  it('returns false for empty address', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(validateCalldata(1, '')).toBe(false)
    spy.mockRestore()
  })

  it('case-insensitive (lowercase input matches mixed-case allowlist)', () => {
    expect(validateCalldata(1, '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5')).toBe(true)
  })
})
