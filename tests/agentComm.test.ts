import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Route } from '../src/core/types'

// Minimal DOM mocks for agent-output
function createMockDocument() {
  const elements: Record<string, any> = {}
  return {
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (tag: string) => {
      const el: any = {
        id: '',
        hidden: false,
        dataset: {},
        textContent: '',
        setAttribute: vi.fn(),
      }
      return el
    },
    body: {
      appendChild: (el: any) => { elements[el.id] = el },
    },
  }
}

function makeRoute(provider: string, amountReceivedUSD = 99): Route {
  return {
    type: 'direct',
    provider,
    steps: [{
      action: 'bridge',
      provider,
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChain: 1,
      toChain: 8453,
      amountIn: '100000000',
      amountOut: '99000000',
      gasCostUSD: 0.5,
      feeUSD: 0.15,
      estimatedTime: 30,
    }],
    totalCostUSD: 0.65,
    estimatedTime: 30,
    amountReceived: '99.0',
    amountReceivedUSD: amountReceivedUSD,
    quoteExpiresAt: Date.now() + 60_000,
  }
}

describe('agent-output — emitAgentRoutes', () => {
  let emitAgentRoutes: typeof import('../src/ui/agent-output').emitAgentRoutes
  let mockDoc: ReturnType<typeof createMockDocument>
  let dispatched: CustomEvent[] = []

  beforeEach(async () => {
    vi.resetModules()
    dispatched = []
    mockDoc = createMockDocument()
    vi.stubGlobal('document', mockDoc)
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent) => { dispatched.push(e) },
    })
    const mod = await import('../src/ui/agent-output')
    emitAgentRoutes = mod.emitAgentRoutes
  })

  it('creates #agent-routes element on first call', () => {
    emitAgentRoutes([], 'loading')
    const el = mockDoc.getElementById('agent-routes')
    expect(el).not.toBeNull()
    expect(el.hidden).toBe(true)
    expect(el.dataset.status).toBe('loading')
  })

  it('sets status and seq on element', () => {
    emitAgentRoutes([makeRoute('Across')], 'ready')
    const el = mockDoc.getElementById('agent-routes')
    expect(el.dataset.status).toBe('ready')
    expect(el.dataset.seq).toBe('1')
    expect(el.dataset.timestamp).toBeDefined()
  })

  it('serializes route data as JSON', () => {
    emitAgentRoutes([makeRoute('Relay', 98.5)], 'ready')
    const el = mockDoc.getElementById('agent-routes')
    const data = JSON.parse(el.textContent)
    expect(data).toHaveLength(1)
    expect(data[0].provider).toBe('Relay')
    expect(data[0].amountReceivedUSD).toBe(98.5)
    expect(data[0].steps).toHaveLength(1)
    expect(data[0].steps[0].fromChain).toBe(1)
  })

  it('fires agent-routes-ready event', () => {
    emitAgentRoutes([makeRoute('Across')], 'ready')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].type).toBe('agent-routes-ready')
    expect(dispatched[0].detail.status).toBe('ready')
    expect(dispatched[0].detail.seq).toBe(1)
    expect(dispatched[0].detail.routes).toHaveLength(1)
  })

  it('increments seq on subsequent calls', () => {
    emitAgentRoutes([], 'loading')
    emitAgentRoutes([makeRoute('Across')], 'ready')
    const el = mockDoc.getElementById('agent-routes')
    expect(el.dataset.seq).toBe('2')
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1].detail.seq).toBe(2)
  })

  it('emits empty array for no-routes', () => {
    emitAgentRoutes([], 'no-routes')
    const el = mockDoc.getElementById('agent-routes')
    expect(el.dataset.status).toBe('no-routes')
    expect(JSON.parse(el.textContent)).toEqual([])
  })

  it('emits empty array for error', () => {
    emitAgentRoutes([], 'error')
    const el = mockDoc.getElementById('agent-routes')
    expect(el.dataset.status).toBe('error')
  })
})

describe('agent-input — setupAgentInputListener', () => {
  let setupAgentInputListener: typeof import('../src/ui/agent-input').setupAgentInputListener
  let listeners: Record<string, Function[]> = {}

  beforeEach(async () => {
    vi.resetModules()
    listeners = {}
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: Function) => {
        if (!listeners[type]) listeners[type] = []
        listeners[type].push(fn)
      },
    })
    const mod = await import('../src/ui/agent-input')
    setupAgentInputListener = mod.setupAgentInputListener
  })

  it('calls callback with valid lowercase provider', () => {
    const cb = vi.fn()
    setupAgentInputListener(cb)
    const handler = listeners['agent-select-route'][0]
    handler(new CustomEvent('agent-select-route', { detail: { provider: 'across' } }))
    expect(cb).toHaveBeenCalledWith('across')
  })

  it('accepts hyphenated provider names', () => {
    const cb = vi.fn()
    setupAgentInputListener(cb)
    const handler = listeners['agent-select-route'][0]
    handler(new CustomEvent('agent-select-route', { detail: { provider: 'stargate-taxi' } }))
    expect(cb).toHaveBeenCalledWith('stargate-taxi')
  })

  it('rejects provider with uppercase', () => {
    const cb = vi.fn()
    setupAgentInputListener(cb)
    const handler = listeners['agent-select-route'][0]
    handler(new CustomEvent('agent-select-route', { detail: { provider: 'Across' } }))
    expect(cb).not.toHaveBeenCalled()
  })

  it('rejects provider with special chars', () => {
    const cb = vi.fn()
    setupAgentInputListener(cb)
    const handler = listeners['agent-select-route'][0]
    handler(new CustomEvent('agent-select-route', { detail: { provider: 'across<script>' } }))
    expect(cb).not.toHaveBeenCalled()
  })

  it('rejects non-string provider', () => {
    const cb = vi.fn()
    setupAgentInputListener(cb)
    const handler = listeners['agent-select-route'][0]
    handler(new CustomEvent('agent-select-route', { detail: { provider: 42 } }))
    expect(cb).not.toHaveBeenCalled()
  })

  it('rejects missing detail', () => {
    const cb = vi.fn()
    setupAgentInputListener(cb)
    const handler = listeners['agent-select-route'][0]
    handler(new CustomEvent('agent-select-route'))
    expect(cb).not.toHaveBeenCalled()
  })
})
