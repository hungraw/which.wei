import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isExpired } from '../src/core/quote'
import type { Route } from '../src/core/types'

/**
 * Test quote expiry logic — ensures stale quotes are rejected
 * before sending wallet transactions.
 *
 * Uses vi.useFakeTimers() for deterministic time control (no flaky tests).
 * Imports the REAL isExpired from core/quote.ts (no copy-paste).
 */

const NOW = 1_700_000_000_000 // fixed anchor: Nov 14 2023 22:13:20 UTC

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    type: 'direct',
    provider: 'test',
    steps: [],
    totalCostUSD: 1,
    estimatedTime: 30,
    amountReceived: '100000000',
    amountReceivedUSD: 100,
    quoteExpiresAt: NOW + 60_000,
    ...overrides,
  }
}

describe('isExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fresh quote (60s TTL) → not expired', () => {
    const route = makeRoute({ quoteExpiresAt: NOW + 60_000 })
    expect(isExpired(route)).toBe(false)
  })

  it('1s before expiry → not expired', () => {
    const route = makeRoute({ quoteExpiresAt: NOW + 1_000 })
    expect(isExpired(route)).toBe(false)
  })

  it('exactly at expiry boundary → not expired (> not >=)', () => {
    const route = makeRoute({ quoteExpiresAt: NOW })
    expect(isExpired(route)).toBe(false)
  })

  it('1ms past expiry → expired', () => {
    const route = makeRoute({ quoteExpiresAt: NOW - 1 })
    expect(isExpired(route)).toBe(true)
  })

  it('long-expired quote (1h ago) → expired', () => {
    const route = makeRoute({ quoteExpiresAt: NOW - 3_600_000 })
    expect(isExpired(route)).toBe(true)
  })

  it('time advancing causes expiry', () => {
    const route = makeRoute({ quoteExpiresAt: NOW + 30_000 }) // expires in 30s
    expect(isExpired(route)).toBe(false)
    vi.advanceTimersByTime(30_001) // advance past expiry
    expect(isExpired(route)).toBe(true)
  })

  it('time advancing — still valid at 29s, expired at 31s', () => {
    const route = makeRoute({ quoteExpiresAt: NOW + 30_000 })
    vi.advanceTimersByTime(29_000)
    expect(isExpired(route)).toBe(false)
    vi.advanceTimersByTime(2_000) // now at NOW + 31_000
    expect(isExpired(route)).toBe(true)
  })
})
