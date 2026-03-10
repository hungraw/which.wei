import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAIN_ID } from '../src/config/chains'

describe('utils/rpc', () => {
  let store: Map<string, string>

  beforeEach(() => {
    vi.resetModules()
    store = new Map<string, string>()

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sanitizes and stores only allowed custom RPC URLs', async () => {
    const rpc = await import('../src/utils/rpc')

    rpc.setCustomRpcUrl(CHAIN_ID.ETHEREUM, 'https://rpc.example.org')
    expect(rpc.getCustomRpcUrl(CHAIN_ID.ETHEREUM)).toBe('https://rpc.example.org/')

    rpc.setCustomRpcUrl(CHAIN_ID.ETHEREUM, 'http://evil.example.org')
    expect(rpc.getCustomRpcUrl(CHAIN_ID.ETHEREUM)).toBe('')

    rpc.setCustomRpcUrl(CHAIN_ID.ETHEREUM, 'http://localhost:8545')
    expect(rpc.getCustomRpcUrl(CHAIN_ID.ETHEREUM)).toBe('http://localhost:8545/')

    rpc.setCustomRpcUrl(CHAIN_ID.ETHEREUM, 'https://user:pass@rpc.example.org')
    expect(rpc.getCustomRpcUrl(CHAIN_ID.ETHEREUM)).toBe('')
  })

  it('fails over to next RPC candidate when first endpoint errors', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('first-fail.example.org')) {
        throw new Error('first endpoint down')
      }
      if (url.includes('publicnode')) {
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }),
        } as Response
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'bad' } }),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const rpc = await import('../src/utils/rpc')
    rpc.setCustomRpcUrl(CHAIN_ID.ETHEREUM, 'https://first-fail.example.org')

    const result = await rpc.rpcRequest<string>(CHAIN_ID.ETHEREUM, 'eth_chainId')

    expect(result).toBe('0x1')
    expect(fetchMock).toHaveBeenCalled()
    expect(rpc.getRpcSettings().lastGoodByChainId[String(CHAIN_ID.ETHEREUM)]).toContain('publicnode')
  })
})
