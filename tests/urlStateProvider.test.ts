import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseUrlStateFromHash } from '../src/ui/url-state'

function setHash(hash: string) {
  vi.stubGlobal('window', { location: { hash } })
}

describe('parseUrlStateFromHash — provider field', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a simple lowercase provider', () => {
    setHash('#/?provider=across')
    expect(parseUrlStateFromHash().provider).toBe('across')
  })

  it('accepts a hyphenated provider', () => {
    setHash('#/?provider=cctp-slow')
    expect(parseUrlStateFromHash().provider).toBe('cctp-slow')
  })

  it('accepts provider with numbers', () => {
    setHash('#/?provider=mayan-mctp')
    expect(parseUrlStateFromHash().provider).toBe('mayan-mctp')
  })

  it('rejects provider with uppercase', () => {
    setHash('#/?provider=Across')
    expect(parseUrlStateFromHash().provider).toBeUndefined()
  })

  it('rejects provider with spaces', () => {
    setHash('#/?provider=cctp%20fast')
    expect(parseUrlStateFromHash().provider).toBeUndefined()
  })

  it('rejects provider with dots', () => {
    setHash('#/?provider=gas.zip')
    expect(parseUrlStateFromHash().provider).toBeUndefined()
  })

  it('rejects empty provider', () => {
    setHash('#/?provider=')
    expect(parseUrlStateFromHash().provider).toBeUndefined()
  })

  it('rejects provider with special chars', () => {
    setHash('#/?provider=across<script>')
    expect(parseUrlStateFromHash().provider).toBeUndefined()
  })

  it('omits provider when param absent', () => {
    setHash('#/?from=1&to=8453')
    expect(parseUrlStateFromHash().provider).toBeUndefined()
  })

  it('coexists with other params', () => {
    setHash('#/?from=1&to=8453&token=USDC&amount=50&provider=relay')
    const s = parseUrlStateFromHash()
    expect(s.from).toBe(1)
    expect(s.to).toBe(8453)
    expect(s.token).toBe('USDC')
    expect(s.amount).toBe('50')
    expect(s.provider).toBe('relay')
  })
})
