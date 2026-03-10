import type { Route } from '../core/types'
import { chainById, displayTokenSymbol } from '../config/chains'
import { getTokenDecimals, STABLECOINS } from '../config/tokens'
import { formatTime, formatUSDFee } from '../utils/format'
import { renderChainSummary, renderProviderRow } from './bridge-summary'
import { iconArrowRightLong, iconWarnPixel, iconX } from './icons'
import { setTrustedSvg } from '../utils/dom'

/** Show a confirmation dialog before bridge execution. Returns true if user confirms. */
export function showConfirmation(
  route: Route,
  tokenSymbol: string,
  fromChainId: number,
  toChainId: number,
  opts: { canConfirm?: boolean; onConfirmBlocked?: () => void; confirmDisabledReason?: string; recipient?: string; recipientName?: string } = {},
): Promise<boolean> {
  const fromChain = chainById.get(fromChainId)
  const toChain = chainById.get(toChainId)
  const srcDecimals = getTokenDecimals(tokenSymbol, fromChainId) ?? 6
  const dstDecimals = getTokenDecimals(tokenSymbol, toChainId) ?? 6
  const fromTokenSymbol = displayTokenSymbol(tokenSymbol, fromChainId)
  const toTokenSymbol = displayTokenSymbol(tokenSymbol, toChainId)
  const isStable = STABLECOINS.has(tokenSymbol.toUpperCase())
  const displayDec = isStable ? 2 : 5

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'confirm-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.tabIndex = -1

    const lossPercent = route._uiLossPercent
    if (lossPercent) {
      const warn = document.createElement('div')
      warn.className = 'confirm-warning'
      const warnIcon = document.createElement('span')
      warnIcon.className = 'confirm-warning-icon'
      setTrustedSvg(warnIcon, iconWarnPixel(12))
      warn.append(warnIcon, document.createTextNode(`${lossPercent}% loss`))
      dialog.appendChild(warn)
    }

    if (opts.recipient) {
      const crossAddr = document.createElement('div')
      crossAddr.className = 'confirm-cross-addr'
      const label = document.createElement('div')
      label.className = 'confirm-cross-addr-label'
      setTrustedSvg(label, iconWarnPixel(10))
      label.append(document.createTextNode(' CROSS-ADDRESS TRANSFER'))
      const toRow = document.createElement('div')
      toRow.className = 'confirm-cross-addr-row'
      const truncate = (addr: string) => `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`
      toRow.textContent = `to: ${opts.recipientName ? `${opts.recipientName} (${truncate(opts.recipient)})` : truncate(opts.recipient)}`
      toRow.title = opts.recipient
      crossAddr.append(label, toRow)
      dialog.appendChild(crossAddr)
    }

    const details = document.createElement('div')
    details.className = 'confirm-details'

    const summary = renderChainSummary({
      fromChain, toChain,
      sendAmount: route.steps[0].amountIn,
      receiveAmount: route.amountReceived,
      tokenSymbol, srcDecimals, dstDecimals,
      sendTokenSymbol: fromTokenSymbol,
      receiveTokenSymbol: toTokenSymbol,
      displayDecimals: displayDec,
      classPrefix: 'confirm',
    })

    const meta = document.createElement('div')
    meta.className = 'confirm-meta'

    const provider = renderProviderRow(route.provider, 'confirm', 11, `(${formatTime(route.estimatedTime)})`)

    const fee = document.createElement('div')
    fee.className = 'confirm-fee'
    fee.textContent = `fee ${formatUSDFee(route.totalCostUSD)}`

    meta.append(fee, provider)

    details.append(summary, meta)

    const actions = document.createElement('div')
    actions.className = 'confirm-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'bridge-btn confirm-cancel'
    setTrustedSvg(cancelBtn, iconX(16))
    cancelBtn.setAttribute('aria-label', 'cancel')
    cancelBtn.title = 'cancel'

    const confirmBtn = document.createElement('button')
    confirmBtn.className = 'bridge-btn confirm-bridge'
    setTrustedSvg(confirmBtn, iconArrowRightLong(34, 16))
    confirmBtn.setAttribute('aria-label', 'confirm')
    confirmBtn.title = 'confirm'

    const canConfirm = opts.canConfirm !== false

    function cleanup(result: boolean) {
      document.removeEventListener('keydown', onKeyDown)
      overlay.remove()
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      }
      resolve(result)
    }

    cancelBtn.addEventListener('click', () => cleanup(false))

    if (canConfirm) {
      confirmBtn.addEventListener('click', () => cleanup(true))
    } else {
      confirmBtn.classList.add('is-disabled')
      confirmBtn.setAttribute('aria-disabled', 'true')
      confirmBtn.title = opts.confirmDisabledReason ?? 'connect wallet to confirm'
      const onConfirmBlocked = opts.onConfirmBlocked
      if (onConfirmBlocked) {
        confirmBtn.addEventListener('click', () => {
          try {
            onConfirmBlocked()
          } finally {
            cleanup(false)
          }
        })
      } else {
        confirmBtn.disabled = true
      }
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false)
    })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cleanup(false)
        return
      }

      if (e.key !== 'Tab') return

      const focusables = [cancelBtn, confirmBtn].filter((el) => !el.disabled)
      if (focusables.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null

      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault()
          last.focus()
        }
        return
      }

      if (active === last || !dialog.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    actions.append(cancelBtn, confirmBtn)
    dialog.append(details, actions)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    if (confirmBtn.disabled) {
      cancelBtn.focus()
    } else {
      confirmBtn.focus()
    }
  })
}
