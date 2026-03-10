import { describe, it, expect } from 'vitest'
import { verifyCalldataRecipient } from '../src/wallet/transactions'

/**
 * Test the calldata recipient verification utility.
 * This guards against API supply-chain attacks where a compromised
 * bridge API could replace the recipient address in opaque calldata.
 */

describe('verifyCalldataRecipient', () => {
  const USER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' // vitalik.eth

  // ABI-encoded form: 12 bytes zero + 20 bytes address (no 0x prefix, all lowercase)
  const encoded = '000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045'

  it('detects address in ABI-encoded calldata', () => {
    const calldata = '0x12345678' + encoded + 'deadbeef'
    expect(verifyCalldataRecipient(calldata, USER)).toBe(true)
  })

  it('detects address regardless of case in calldata', () => {
    const calldata = '0x12345678' + encoded.toUpperCase() + 'DEADBEEF'
    expect(verifyCalldataRecipient(calldata, USER)).toBe(true)
  })

  it('detects address regardless of case in user address', () => {
    const calldata = '0x12345678' + encoded
    expect(verifyCalldataRecipient(calldata, USER.toLowerCase())).toBe(true)
    expect(verifyCalldataRecipient(calldata, USER.toUpperCase())).toBe(true)
  })

  it('rejects calldata that does not contain the address', () => {
    // Different address entirely
    const otherEncoded = '0000000000000000000000001234567890abcdef1234567890abcdef12345678'
    const calldata = '0x12345678' + otherEncoded
    expect(verifyCalldataRecipient(calldata, USER)).toBe(false)
  })

  it('rejects empty calldata', () => {
    expect(verifyCalldataRecipient('', USER)).toBe(false)
  })

  it('rejects empty user address', () => {
    expect(verifyCalldataRecipient('0x1234', '')).toBe(false)
  })

  it('rejects when both are empty', () => {
    expect(verifyCalldataRecipient('', '')).toBe(false)
  })

  it('handles calldata without 0x prefix', () => {
    const calldata = '12345678' + encoded
    expect(verifyCalldataRecipient(calldata, USER)).toBe(true)
  })

  it('handles user address without 0x prefix', () => {
    const calldata = '0x12345678' + encoded
    expect(verifyCalldataRecipient(calldata, 'd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(true)
  })

  it('accepts raw 20-byte address encoding', () => {
    // Some providers pack addresses (20-byte) rather than full ABI-encoding.
    const rawOnly = 'd8da6bf26964af9d7eed9e03e53415d37aa96045'
    const calldata = '0xdeadbeef' + rawOnly + 'cafebabe'
    expect(verifyCalldataRecipient(calldata, USER)).toBe(true)
  })
})
