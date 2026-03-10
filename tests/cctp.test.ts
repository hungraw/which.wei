import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calculateCctpProtocolFee,
  selectCctpFeeTier,
  pollCctpAttestation,
} from '../src/providers/cctp'
import { resetRateLimitState } from '../src/utils/rate-limit'

describe('providers/cctp primitives', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetRateLimitState('cctp-messages')
  })

  it('calculates protocol fee in minor units with ceil rounding for decimal bps', () => {
    const amount = 1_000_000n // 1 USDC
    const fee = calculateCctpProtocolFee(amount, 1.3)
    expect(fee).toBe(130n)
  })

  it('selects FAST fee tier by finality threshold', () => {
    const tier = selectCctpFeeTier([
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 10, medium: 11, high: 12 } },
      { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 20, medium: 21, high: 22 } },
    ], 1000)

    expect(tier?.minimumFee).toBe(1.3)
    expect(tier?.forwardFee?.medium).toBe(21)
  })

  it('polls until complete and returns message + attestation', async () => {
    const message = '0x1234'
    const attestation = '0x5678'
    const txHash = `0x${'a'.repeat(64)}`

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{
            status: 'complete',
            message,
            attestation,
            forwardTxHash: `0x${'b'.repeat(64)}`,
          }],
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    const result = await pollCctpAttestation(6, txHash, {
      intervalMs: 1,
      timeoutMs: 200,
    })

    expect(result.status).toBe('complete')
    expect(result.message).toBe(message)
    expect(result.attestation).toBe(attestation)
    expect(result.forwardTxHash).toBe(`0x${'b'.repeat(64)}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits for forward tx hash when strict completion is required', async () => {
    const txHash = `0x${'d'.repeat(64)}`

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{
            status: 'complete',
            message: '0xabc',
            attestation: '0xdef',
            forwardState: 'PENDING',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{
            status: 'complete',
            message: '0xabc',
            attestation: '0xdef',
            forwardState: 'SUCCEEDED',
            forwardTxHash: `0x${'e'.repeat(64)}`,
          }],
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    const result = await pollCctpAttestation(6, txHash, {
      intervalMs: 1,
      timeoutMs: 200,
      requireForwardTxHash: true,
    })

    expect(result.status).toBe('complete')
    expect(result.forwardTxHash).toBe(`0x${'e'.repeat(64)}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ignores failed forward tx attempts and waits for successful forwarding hash', async () => {
    const txHash = `0x${'f'.repeat(64)}`

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{
            status: 'complete',
            message: '0xabc',
            attestation: '0xdef',
            forwardState: 'FAILED',
            forwardTxHash: `0x${'1'.repeat(64)}`,
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{
            status: 'complete',
            message: '0xabc',
            attestation: '0xdef',
            forwardState: 'SUCCEEDED',
            forwardTxHash: `0x${'2'.repeat(64)}`,
          }],
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    const result = await pollCctpAttestation(6, txHash, {
      intervalMs: 1,
      timeoutMs: 200,
      requireForwardTxHash: true,
    })

    expect(result.status).toBe('complete')
    expect(result.forwardTxHash).toBe(`0x${'2'.repeat(64)}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns timeout when attestation never completes', async () => {
    const txHash = `0x${'c'.repeat(64)}`
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pollCctpAttestation(6, txHash, {
      intervalMs: 1,
      timeoutMs: 8,
    })

    expect(result.status).toBe('timeout')
  })
})
