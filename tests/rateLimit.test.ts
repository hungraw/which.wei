import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRateLimitDelay,
  recordRequest,
  resetRateLimitState,
  setProviderRateLimit,
  waitForRateLimit,
} from '../src/utils/rate-limit'

describe('rate-limit utility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    resetRateLimitState()
  })

  afterEach(() => {
    resetRateLimitState()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('allows up to default limit before requiring delay', () => {
    recordRequest('across')
    expect(getRateLimitDelay('across')).toBe(0)

    recordRequest('across')
    expect(getRateLimitDelay('across')).toBe(1000)
  })

  it('uses per-provider custom config', () => {
    setProviderRateLimit('relay', { maxRequests: 1, windowMs: 2000 })

    recordRequest('relay')
    expect(getRateLimitDelay('relay')).toBe(2000)

    vi.advanceTimersByTime(500)
    expect(getRateLimitDelay('relay')).toBe(1500)
  })

  it('waitForRateLimit waits and then records request', async () => {
    setProviderRateLimit('eco', { maxRequests: 1, windowMs: 1000 })
    recordRequest('eco')

    const pending = waitForRateLimit('eco')
    let resolved = false
    void pending.then(() => { resolved = true })

    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(getRateLimitDelay('eco')).toBe(1000)
  })

  it('resetRateLimitState clears one provider or all providers', () => {
    setProviderRateLimit('across', { maxRequests: 1, windowMs: 1000 })
    setProviderRateLimit('relay', { maxRequests: 1, windowMs: 1000 })

    recordRequest('across')
    recordRequest('relay')

    expect(getRateLimitDelay('across')).toBeGreaterThan(0)
    expect(getRateLimitDelay('relay')).toBeGreaterThan(0)

    resetRateLimitState('across')
    expect(getRateLimitDelay('across')).toBe(0)
    expect(getRateLimitDelay('relay')).toBeGreaterThan(0)

    resetRateLimitState()
    expect(getRateLimitDelay('relay')).toBe(0)
  })
})
