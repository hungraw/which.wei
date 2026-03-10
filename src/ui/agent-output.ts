import type { Route } from '../core/types'

interface AgentRouteData {
  provider: string
  amountReceived: string
  amountReceivedUSD: number
  totalCostUSD: number
  estimatedTime: number
  steps: Array<{
    action: string
    provider: string
    fromChain: number
    toChain: number
    fromToken: string
    toToken: string
    gasCostUSD: number
    feeUSD: number
  }>
}

let routeSeq = 0

export function emitAgentRoutes(routes: Route[], status: 'ready' | 'loading' | 'error' | 'no-routes'): void {
  const data: AgentRouteData[] = routes.map(r => ({
    provider: r.provider,
    amountReceived: r.amountReceived,
    amountReceivedUSD: r.amountReceivedUSD,
    totalCostUSD: r.totalCostUSD,
    estimatedTime: r.estimatedTime,
    steps: r.steps.map(s => ({
      action: s.action,
      provider: s.provider,
      fromChain: s.fromChain,
      toChain: s.toChain,
      fromToken: s.fromToken,
      toToken: s.toToken,
      gasCostUSD: s.gasCostUSD,
      feeUSD: s.feeUSD,
    })),
  }))

  routeSeq++

  let el = document.getElementById('agent-routes')
  if (!el) {
    el = document.createElement('div')
    el.id = 'agent-routes'
    el.hidden = true
    el.setAttribute('aria-hidden', 'true')
    document.body.appendChild(el)
  }
  el.dataset.status = status
  el.dataset.seq = String(routeSeq)
  el.dataset.timestamp = String(Date.now())
  el.textContent = JSON.stringify(data)

  window.dispatchEvent(new CustomEvent('agent-routes-ready', {
    detail: { routes: data, status, seq: routeSeq },
  }))
}
