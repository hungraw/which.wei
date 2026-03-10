import type { RouteStep } from '../core/types'
import { explorerTxUrl } from '../utils/format'
import { iconCircle, iconCircleDot, iconCheck, iconCross, iconExternalLink } from './icons'
import { appendTrustedSvg, clearChildren, setTrustedSvg } from '../utils/dom'

type StepStatus = 'pending' | 'active' | 'done' | 'failed'

interface StatusStep {
  label: string
  status: StepStatus
  txHash?: string
  explorerUrl?: string
}

export function renderTxProgress(
  container: HTMLElement,
  steps: RouteStep[],
  currentStep: number,
  txHashes: (string | null)[],
  explorerUrl: string,
  failed = false,
): void {
  clearChildren(container)

  const statusSteps: StatusStep[] = steps.map((step, i) => {
    const action = step.action === 'swap'
      ? `Swap ${step.fromToken} → ${step.toToken}`
      : `Sending ${step.fromToken}`

    let status: StepStatus = 'pending'
    if (i < currentStep) status = 'done'
    else if (i === currentStep) status = failed ? 'failed' : 'active'

    return {
      label: action,
      status,
      txHash: txHashes[i] ?? undefined,
      explorerUrl,
    }
  })

  for (const step of statusSteps) {
    const row = document.createElement('div')
    row.className = `status-step ${step.status}`

    const icons: Record<StepStatus, string> = {
      pending: iconCircle(14),
      active: iconCircleDot(14),
      done: iconCheck(14),
      failed: iconCross(14),
    }

    const icon = document.createElement('span')
    icon.className = 'icon'
    setTrustedSvg(icon, icons[step.status])

    const label = document.createElement('span')
    label.textContent = step.label

    row.append(icon, label)

    if (step.txHash && step.explorerUrl) {
      const url = explorerTxUrl(step.explorerUrl, step.txHash)
      if (url) {
        const link = document.createElement('a')
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.appendChild(document.createTextNode(' '))
        appendTrustedSvg(link, iconExternalLink(12))
        link.style.color = 'inherit'
        row.appendChild(link)
      }
    }

    container.appendChild(row)
  }
}
