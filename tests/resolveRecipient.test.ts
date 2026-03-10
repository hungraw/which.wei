import { describe, it, expect, vi, afterEach } from 'vitest'

// ── helpers ──────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const VITALIK   = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

// Shared mock — all calls to createPublicClient() in the module under test
// return the same object so we can control readContract from these tests.
const mockReadContract = vi.fn()

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: () => ({ readContract: mockReadContract }),
  }
})

import { resolveRecipient } from '../src/utils/resolve-name'

afterEach(() => {
  mockReadContract.mockReset()
})

// ─────────────────────────────────────────────────────────────────────

describe('resolveRecipient — raw 0x addresses', () => {
  it('passes through a valid 0x40 address unchanged', async () => {
    const result = await resolveRecipient(VITALIK)
    expect(result).toEqual({ address: VITALIK, name: undefined, nameType: undefined })
  })

  it('passes through a lowercase 0x address unchanged', async () => {
    const lower = VITALIK.toLowerCase()
    const result = await resolveRecipient(lower)
    expect(result).toEqual({ address: lower, name: undefined, nameType: undefined })
  })

  it('throws on a 0x address that is too short (39 hex chars)', async () => {
    await expect(resolveRecipient('0x' + 'a'.repeat(39))).rejects.toThrow()
  })

  it('throws on a 0x address that is too long (41 hex chars)', async () => {
    await expect(resolveRecipient('0x' + 'a'.repeat(41))).rejects.toThrow()
  })

  it('throws on a plain non-address non-name string', async () => {
    await expect(resolveRecipient('notanaddress')).rejects.toThrow('Invalid recipient format')
  })
})

// ─────────────────────────────────────────────────────────────────────

describe('resolveRecipient — ENS (.eth) resolution', () => {
  it('resolves a valid ENS name: resolver + addr calls succeed', async () => {
    const fakeResolver = '0x1111111111111111111111111111111111111111'
    mockReadContract
      .mockResolvedValueOnce(fakeResolver)   // registry.resolver(node)
      .mockResolvedValueOnce(VITALIK)        // resolver.addr(node)

    const result = await resolveRecipient('vitalik.eth')
    expect(result).toEqual({ address: VITALIK, name: 'vitalik.eth', nameType: 'ens' })
  })

  it('throws when resolver returns zero address', async () => {
    mockReadContract.mockResolvedValueOnce(ZERO_ADDR)
    await expect(resolveRecipient('unregistered.eth')).rejects.toThrow('does not resolve')
  })

  it('throws when addr() returns zero address', async () => {
    mockReadContract
      .mockResolvedValueOnce('0x1111111111111111111111111111111111111111')
      .mockResolvedValueOnce(ZERO_ADDR)
    await expect(resolveRecipient('noaddr.eth')).rejects.toThrow('does not resolve')
  })

  it('throws when ENS registry call throws', async () => {
    mockReadContract.mockRejectedValueOnce(new Error('RPC error'))
    await expect(resolveRecipient('failing.eth')).rejects.toThrow('does not resolve')
  })

  it('throws on a single-label ".eth" (too short)', async () => {
    await expect(resolveRecipient('.eth')).rejects.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────

describe('resolveRecipient — WNS (.wei) resolution', () => {
  it('resolves a valid WNS name: single readContract call', async () => {
    mockReadContract.mockResolvedValueOnce(VITALIK)

    const result = await resolveRecipient('which.wei')
    expect(result).toEqual({ address: VITALIK, name: 'which.wei', nameType: 'wns' })
  })

  it('throws when WNS addr() returns zero address', async () => {
    mockReadContract.mockResolvedValueOnce(ZERO_ADDR)
    await expect(resolveRecipient('unregistered.wei')).rejects.toThrow('does not resolve')
  })

  it('throws when WNS readContract throws', async () => {
    mockReadContract.mockRejectedValueOnce(new Error('RPC error'))
    await expect(resolveRecipient('failing.wei')).rejects.toThrow('does not resolve')
  })

  it('throws on ".wei" with no label', async () => {
    await expect(resolveRecipient('.wei')).rejects.toThrow()
  })
})
