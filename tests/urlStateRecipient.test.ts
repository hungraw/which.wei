import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseUrlStateFromHash, syncUrlHash } from '../src/ui/url-state'
import type { AppState } from '../src/core/types'

function setHash(hash: string) {
  vi.stubGlobal('window', { location: { hash } })
}

// Minimal AppState with just the fields syncUrlHash reads
function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    amount: '', token: null, fromChain: null, toChain: null,
    routes: null, status: 'idle', error: null,
    ...overrides,
  }
}

describe('parseUrlStateFromHash — recipient field', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  // ── valid 0x address ───────────────────────────────────────────────

  it('accepts a valid 0x40 address', () => {
    setHash('#/?recipient=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  })

  it('accepts a lowercase 0x address', () => {
    setHash('#/?recipient=0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBe('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
  })

  // ── ENS names ─────────────────────────────────────────────────────

  it('accepts a two-label .eth name', () => {
    setHash('#/?recipient=vitalik.eth')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBe('vitalik.eth')
  })

  it('accepts a three-label .eth name', () => {
    setHash('#/?recipient=sub.vitalik.eth')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBe('sub.vitalik.eth')
  })

  // ── WNS names ─────────────────────────────────────────────────────

  it('accepts a two-label .wei name', () => {
    setHash('#/?recipient=which.wei')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBe('which.wei')
  })

  // ── invalid / security cases ──────────────────────────────────────

  it('ignores an address that is too short (39 hex)', () => {
    setHash('#/?recipient=0x' + 'a'.repeat(39))
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBeUndefined()
  })

  it('ignores a random word (no domain, no 0x)', () => {
    setHash('#/?recipient=notanaddress')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBeUndefined()
  })

  it('ignores an empty recipient param', () => {
    setHash('#/?recipient=')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBeUndefined()
  })

  it('returns no recipient when param is absent', () => {
    setHash('#/?from=1&to=8453&token=USDC')
    const { recipient } = parseUrlStateFromHash()
    expect(recipient).toBeUndefined()
  })

  // ── coexists with other params ────────────────────────────────────

  it('parses recipient alongside from/to/token', () => {
    setHash('#/?from=1&to=8453&token=USDC&recipient=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    const state = parseUrlStateFromHash()
    expect(state.from).toBe(1)
    expect(state.to).toBe(8453)
    expect(state.token).toBe('USDC')
    expect(state.recipient).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  })
})

// ── syncUrlHash writes recipient back to URL ──────────────────────────

describe('syncUrlHash — recipient field', () => {
  let historyState: string | null = null

  beforeEach(() => {
    historyState = null
    vi.stubGlobal('window', {
      location: { hash: '', pathname: '/', search: '' },
      history: { replaceState: (_: unknown, __: string, url: string) => { historyState = url } },
    })
  })

  it('writes agentRecipient (raw address) to URL when set', () => {
    const state = makeState({ agentRecipient: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' })
    syncUrlHash(state)
    expect(historyState).toContain('recipient=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  })

  it('always uses address (not name) in URL', () => {
    const state = makeState({
      agentRecipient: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      agentRecipientName: 'vitalik.eth',
    })
    syncUrlHash(state)
    expect(historyState).toContain('recipient=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    expect(historyState).not.toContain('vitalik.eth')
  })

  it('omits recipient from URL when neither is set', () => {
    const state = makeState()
    syncUrlHash(state)
    expect(historyState).not.toContain('recipient')
  })
})
