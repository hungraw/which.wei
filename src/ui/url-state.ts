import type { AppState } from '../core/types'
import { chains } from '../config/chains'
import { tokens } from '../config/tokens'

export type UrlState = {
  from?: number
  to?: number
  token?: string
  recipient?: string
  amount?: string
  provider?: string
}

export function parseUrlStateFromHash(): UrlState {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return {}

  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const normalized = raw.startsWith('/') ? raw.slice(1) : raw
  if (!normalized) return {}

  const out: UrlState = {}

  const qIndex = normalized.indexOf('?')
  if (qIndex >= 0) {
    const qs = normalized.slice(qIndex + 1)
    const params = new URLSearchParams(qs)
    const from = params.get('from')
    const to = params.get('to')
    const token = params.get('token')
    if (from !== null) {
      const n = Number(from)
      if (Number.isFinite(n)) out.from = n
    }
    if (to !== null) {
      const n = Number(to)
      if (Number.isFinite(n)) out.to = n
    }
    if (token !== null) out.token = token
    const amount = params.get('amount')
    if (amount !== null) {
      const n = Number(amount)
      if (Number.isFinite(n) && n > 0) out.amount = amount
    }
    const recipient = params.get('recipient')
    if (recipient !== null) {
      if (/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        out.recipient = recipient
      } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(recipient)) {
        out.recipient = recipient
      } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.wei$/i.test(recipient)) {
        out.recipient = recipient
      }
    }
    const provider = params.get('provider')
    if (provider !== null && /^[a-z0-9-]+$/.test(provider)) out.provider = provider
  }
  return out
}

export function applyUrlState(s: UrlState, state: AppState): void {
  if (typeof s.from === 'number') state.fromChain = chains.find(c => c.id === s.from) ?? state.fromChain
  if (typeof s.to === 'number') state.toChain = chains.find(c => c.id === s.to) ?? state.toChain
  if (typeof s.token === 'string') state.token = tokens.find(t => t.symbol === s.token) ?? state.token
  if (typeof s.amount === 'string') state.amount = s.amount
  if (typeof s.provider === 'string') state.agentProvider = s.provider
}

export function syncUrlHash(state: AppState): void {
  const params = new URLSearchParams()
  if (state.amount && !state.amount.endsWith('%') && !state.amount.startsWith('$')) {
    params.set('amount', state.amount)
  }
  if (state.token) params.set('token', state.token.symbol)
  if (state.fromChain) params.set('from', String(state.fromChain.id))
  if (state.toChain) params.set('to', String(state.toChain.id))
  if (state.agentRecipient) {
    params.set('recipient', state.agentRecipient)
  }

  const qs = params.toString()
  const newHash = qs ? `#/?${qs}` : ''
  const newUrl = `${window.location.pathname}${window.location.search}${newHash}`
  window.history.replaceState(null, '', newUrl)
}

/** Strip recipient and amount from URL after initial load to prevent re-use on refresh. */
export function clearVolatileUrlParams(): void {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return

  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const normalized = raw.startsWith('/') ? raw.slice(1) : raw
  const qIndex = normalized.indexOf('?')
  if (qIndex < 0) return

  const params = new URLSearchParams(normalized.slice(qIndex + 1))
  params.delete('recipient')
  params.delete('amount')
  params.delete('provider')
  const qs = params.toString()
  const newHash = qs ? `#/?${qs}` : ''
  const newUrl = `${window.location.pathname}${window.location.search}${newHash}`
  window.history.replaceState(null, '', newUrl)
}
