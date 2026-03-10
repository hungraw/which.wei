import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('history module', { timeout: 15000 }, () => {
  let store: Map<string, string>

  beforeEach(async () => {
    vi.resetModules()
    store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      txHash: '0x' + 'a'.repeat(64),
      fromChainId: 1,
      toChainId: 8453,
      token: 'USDC',
      amountIn: '100000000',
      amountOut: '99500000',
      provider: 'Across',
      timestamp: 1700000000000,
      ...overrides,
    }
  }

  it('loadHistory returns [] when localStorage is empty', async () => {
    const { loadHistory } = await import('../src/ui/history')
    expect(loadHistory()).toEqual([])
  })

  it('saveTransaction + loadHistory round-trip', async () => {
    const { saveTransaction, loadHistory } = await import('../src/ui/history')
    saveTransaction(makeEntry())
    const history = loadHistory()
    expect(history).toHaveLength(1)
    expect(history[0].provider).toBe('Across')
    expect(history[0].token).toBe('USDC')
  })

  it('newest entry prepended first', async () => {
    const { saveTransaction, loadHistory } = await import('../src/ui/history')
    saveTransaction(makeEntry({ provider: 'First', timestamp: 1000 }))
    saveTransaction(makeEntry({ provider: 'Second', timestamp: 2000, txHash: '0x' + 'b'.repeat(64) }))
    const history = loadHistory()
    expect(history).toHaveLength(2)
    expect(history[0].provider).toBe('Second')
    expect(history[1].provider).toBe('First')
  })

  it('clearHistory empties the list', async () => {
    const { saveTransaction, loadHistory, clearHistory } = await import('../src/ui/history')
    saveTransaction(makeEntry())
    expect(loadHistory()).toHaveLength(1)
    clearHistory()
    expect(loadHistory()).toHaveLength(0)
  })

  it('handles corrupted localStorage gracefully', async () => {
    store.set('whichwei:tx-history', '{not valid json')
    const { loadHistory } = await import('../src/ui/history')
    expect(loadHistory()).toEqual([])
  })

  it('handles non-array in localStorage gracefully', async () => {
    store.set('whichwei:tx-history', '"just a string"')
    const { loadHistory } = await import('../src/ui/history')
    expect(loadHistory()).toEqual([])
  })

  it('caps at 100 entries (MAX_ENTRIES)', async () => {
    const { saveTransaction, loadHistory, MAX_ENTRIES } = await import('../src/ui/history')
    for (let index = 0; index < 105; index++) {
      saveTransaction(makeEntry({ txHash: '0x' + index.toString(16).padStart(64, '0'), timestamp: index }))
    }
    expect(loadHistory()).toHaveLength(MAX_ENTRIES)
    expect(loadHistory()[0].timestamp).toBe(104)
  })
})
