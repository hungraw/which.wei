import { describe, it, expect } from 'vitest'
import { effectiveRecipient } from '../src/utils/recipient'

describe('effectiveRecipient', () => {
  const USER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
  const BOB   = '0xAbCdEf0000000000000000000000000000000001'

  it('returns recipient when explicitly set', () => {
    expect(effectiveRecipient({ userAddress: USER, recipient: BOB })).toBe(BOB)
  })

  it('falls back to userAddress when recipient is undefined', () => {
    expect(effectiveRecipient({ userAddress: USER, recipient: undefined })).toBe(USER)
  })

  it('falls back to userAddress when recipient is absent', () => {
    expect(effectiveRecipient({ userAddress: USER })).toBe(USER)
  })

  it('recipient same as userAddress returns that address', () => {
    expect(effectiveRecipient({ userAddress: USER, recipient: USER })).toBe(USER)
  })
})
