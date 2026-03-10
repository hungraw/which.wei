import type { AppState, Route, BridgeParams, OnStep, ExecuteResult } from '../core/types'
import { chainById, displayTokenSymbol } from '../config/chains'
import { getTokenAddress, getTokenDecimals, STABLECOINS } from '../config/tokens'
import { isExpired } from '../core/quote'
import { openConnectModal, isConnected, getAddress } from '../wallet/connect'
import { switchChain, isOnChain } from '../wallet/chain-switch'
import { renderError } from './results'
import { renderTxProgress } from './status'
import { renderChainSummary, renderProviderRow } from './bridge-summary'
import { showModal, closeModal } from './modal'
import { saveTransaction } from './history'
import { iconArrowRightLong, iconCheck, iconX } from './icons'
import { PROVIDER_ICONS } from './provider-icons'
import type { WalletControls } from './wallet-controls'
import { addBridge, BRIDGE_UPDATE_EVENT, startPolling, type TrackedBridge } from '../tracking'
import { getTokenBalance } from '../utils/balance'
import { explorerTxUrl } from '../utils/format'
import { clearChildren, setTrustedSvg } from '../utils/dom'

interface BridgeFlowDeps {
  state: AppState
  wallet: WalletControls
  resultsContainer: HTMLElement
  statusContainer: HTMLElement
  resetBtn: HTMLElement
  scheduleQuote(): void
  updateBalance(): void
  setPickersDisabled(disabled: boolean): void
  showConfirmation(
    route: Route,
    tokenSymbol: string,
    fromChainId: number,
    toChainId: number,
    opts?: { canConfirm?: boolean; onConfirmBlocked?: () => void; confirmDisabledReason?: string; recipient?: string; recipientName?: string },
  ): Promise<boolean>
  executeProvider(provider: string, params: BridgeParams, route: Route, onStep: OnStep): Promise<ExecuteResult>
}

function extractRouteDisplayInfo(route: Route) {
  const firstStep = route.steps[0]
  const lastStep = route.steps[route.steps.length - 1]
  if (!firstStep || !lastStep) return null

  const fromChainId = firstStep.fromChain
  const toChainId = lastStep.toChain
  const tokenSymbol = firstStep.fromToken
  return {
    fromChainId,
    toChainId,
    fromChain: chainById.get(fromChainId),
    toChain: chainById.get(toChainId),
    tokenSymbol,
    srcDecimals: getTokenDecimals(tokenSymbol, fromChainId) ?? 6,
    dstDecimals: getTokenDecimals(tokenSymbol, toChainId) ?? 6,
    fromTokenSymbol: displayTokenSymbol(tokenSymbol, fromChainId),
    toTokenSymbol: displayTokenSymbol(tokenSymbol, toChainId),
    displayDec: STABLECOINS.has(tokenSymbol.toUpperCase()) ? 3 : 5,
  }
}

export function createBridgeFlow(deps: BridgeFlowDeps) {
  let bridgeLock = false
  const trackedRouteById = new Map<string, Route>()

  function renderStatusMsg(el: HTMLElement, msg: string) {
    const token = deps.state.token
    const tokenIcon = token?.icon
    const tokenSym = token?.symbol

    el.classList.remove('sending', 'approving', 'confirm', 'switching')
    clearChildren(el)

    const setPlain = (text: string, cls?: string) => {
      if (cls) el.classList.add(cls)
      el.textContent = text
    }

    const setWithToken = (prefix: string, cls: string) => {
      el.classList.add(cls)
      el.append(document.createTextNode(prefix))
      if (tokenIcon) {
        const img = document.createElement('img')
        img.className = 'status-token-icon'
        img.src = tokenIcon
        img.alt = tokenSym ?? ''
        img.onerror = () => { img.style.display = 'none' }
        el.appendChild(img)
      }
      if (tokenSym) el.append(document.createTextNode(`${tokenSym}…`))
      else el.append(document.createTextNode('…'))
    }

    if (msg.includes('Sending')) return setWithToken('Sending ', 'sending')
    if (msg.includes('Approving')) return setWithToken('Approving ', 'approving')
    if (msg.includes('Claiming')) return setWithToken('Claiming ', 'sending')
    if (msg.includes('Confirming')) return setPlain(msg, 'confirm')
    if (msg.includes('Switching')) return setPlain(msg, 'switching')
    setPlain(msg)
  }

  function showStatus(msg: string) {
    deps.statusContainer.style.display = ''
    const statusMsg = deps.statusContainer.querySelector('.status-msg') as HTMLElement | null
    if (statusMsg) {
      renderStatusMsg(statusMsg, msg)
    }
  }

  function showBridgeResultModal(success: boolean, route: Route, txHash?: string, destinationTxHash?: string) {
    deps.state.status = success ? 'complete' : 'error'
    const info = extractRouteDisplayInfo(route)
    if (!info) return
    const { fromChain, toChain, tokenSymbol, srcDecimals, dstDecimals, fromTokenSymbol, toTokenSymbol, displayDec } = info

    const content = document.createElement('div')
    content.className = 'bridge-result-content'

    if (success) {
      const icon = document.createElement('div')
      icon.className = 'bridge-result-icon success'
      setTrustedSvg(icon, iconCheck(52))
      content.append(icon)
    } else {
      const icon = document.createElement('div')
      icon.className = 'bridge-result-icon fail'
      setTrustedSvg(icon, iconX(52))
      content.append(icon)
    }

    const isLZ = route.provider === 'Stargate Taxi' || route.provider === 'Stargate Bus' || route.provider === 'USDT0'

    const summary = renderChainSummary({
      fromChain, toChain,
      sendAmount: route.steps[0].amountIn,
      receiveAmount: route.amountReceived,
      tokenSymbol, srcDecimals, dstDecimals,
      sendTokenSymbol: fromTokenSymbol,
      receiveTokenSymbol: toTokenSymbol,
      displayDecimals: displayDec,
      classPrefix: 'bridge-result',
      srcExplorerUrl: success && txHash && fromChain ? fromChain.explorerUrl : undefined,
      srcTxHash: success ? txHash : undefined,
      dstExplorerUrl: success && isLZ && txHash ? 'https://layerzeroscan.com' : (success && destinationTxHash && toChain ? toChain.explorerUrl : undefined),
      dstTxHash: success ? (isLZ ? txHash : destinationTxHash) : undefined,
    })
    content.appendChild(summary)

    // Provider row — last element
    const providerRow = renderProviderRow(route.provider, 'bridge-result', 18, undefined, true)
    content.appendChild(providerRow)

    const btn = document.createElement('button')
    btn.className = 'bridge-btn'
    btn.classList.add('bridge-result-close-btn')
    btn.setAttribute('aria-label', 'close')
    btn.title = 'close'
    setTrustedSvg(btn, iconX(16))
    btn.style.marginTop = '1rem'
    btn.addEventListener('click', () => {
      closeModal()
      deps.statusContainer.style.display = 'none'
      clearChildren(deps.statusContainer)
      deps.state.status = 'idle'
      deps.scheduleQuote()
    })
    content.appendChild(btn)

    showModal({
      title: '',
      content,
      closable: true,
      modalClass: 'bridge-result-modal',
      onClose: () => {
        deps.statusContainer.style.display = 'none'
        clearChildren(deps.statusContainer)
        if (deps.state.status === 'complete' || deps.state.status === 'error') {
          deps.state.status = 'idle'
          deps.scheduleQuote()
        }
      },
    })

    // Notify wallet controls to invalidate balance cache on success
    if (success) {
      window.dispatchEvent(new CustomEvent(BRIDGE_UPDATE_EVENT, { detail: { status: 'completed' } }))
    }

    deps.statusContainer.style.display = 'none'
    clearChildren(deps.statusContainer)
  }

  function showBridgeInFlightModal(route: Route, txHash?: string) {
    const info = extractRouteDisplayInfo(route)
    if (!info) return
    const { fromChain, toChain, tokenSymbol, srcDecimals, dstDecimals, fromTokenSymbol, toTokenSymbol, displayDec } = info

    const content = document.createElement('div')
    content.className = 'bridge-result-content'

    const icon = document.createElement('div')
    icon.className = 'bridge-result-icon'
    const loader = document.createElement('span')
    loader.className = 'history-pending-loader modal-pending-loader'
    icon.append(loader)
    content.append(icon)

    // Status text element — updated by tracking events
    const statusEl = document.createElement('div')
    statusEl.className = 'bridge-inflight-status'
    statusEl.textContent = 'Confirming...'
    content.append(statusEl)

    const srcExplorerUrl = txHash && fromChain ? explorerTxUrl(fromChain.explorerUrl, txHash) : undefined
    const summary = renderChainSummary({
      fromChain,
      toChain,
      sendAmount: route.steps[0].amountIn,
      receiveAmount: route.amountReceived,
      tokenSymbol,
      srcDecimals,
      dstDecimals,
      sendTokenSymbol: fromTokenSymbol,
      receiveTokenSymbol: toTokenSymbol,
      displayDecimals: displayDec,
      classPrefix: 'bridge-result',
      srcExplorerUrl: srcExplorerUrl || undefined,
      srcTxHash: txHash,
    })
    content.appendChild(summary)

    const providerRow = renderProviderRow(route.provider, 'bridge-result', 18, undefined, true)
    content.appendChild(providerRow)

    const btn = document.createElement('button')
    btn.className = 'bridge-btn'
    btn.classList.add('bridge-result-close-btn')
    btn.setAttribute('aria-label', 'close')
    btn.title = 'close'
    setTrustedSvg(btn, iconX(16))
    btn.style.marginTop = '1rem'
    btn.addEventListener('click', () => {
      closeModal()
    })
    content.appendChild(btn)

    showModal({
      title: '',
      content,
      closable: true,
      modalClass: 'bridge-result-modal',
      onClose: () => {
        deps.statusContainer.style.display = 'none'
        clearChildren(deps.statusContainer)
      },
    })

    deps.statusContainer.style.display = 'none'
    clearChildren(deps.statusContainer)
  }

  window.addEventListener(BRIDGE_UPDATE_EVENT, (evt) => {
    const detail = (evt as CustomEvent<TrackedBridge>).detail
    if (!detail) return

    const route = trackedRouteById.get(detail.id)
    if (!route) return

    if (detail.status === 'completed') {
      closeModal()
      showBridgeResultModal(true, route, detail.txHash, detail.fillTxHash)
      trackedRouteById.delete(detail.id)
      return
    }

    if (detail.status === 'claim-ready') {
      closeModal()
      showBridgeResultModal(true, route, detail.txHash, detail.fillTxHash)
      trackedRouteById.delete(detail.id)
      return
    }

    if (detail.status === 'failed' || detail.status === 'unconfirmed') {
      closeModal()
      showBridgeResultModal(false, route, detail.txHash, detail.fillTxHash)
      trackedRouteById.delete(detail.id)
      return
    }

    // Update inflight modal status text
    const statusText = detail.providerStatusText
    if (statusText) {
      const statusEl = document.querySelector('.bridge-inflight-status')
      if (statusEl) statusEl.textContent = statusText.endsWith('...') ? statusText : `${statusText}...`
    }
  })

  async function onBridge(route: Route) {
    if (bridgeLock) return
    bridgeLock = true

    try {
      if (isExpired(route)) {
        renderError(deps.resultsContainer, 'Quote expired. Fetching new routes...')
        deps.scheduleQuote()
        return
      }

      const currentFromChain = deps.state.fromChain
      const currentToChain = deps.state.toChain
      const currentToken = deps.state.token
      if (!currentFromChain || !currentToChain || !currentToken) return

      const tokenSymbol = currentToken.symbol
      const fromChainId = currentFromChain.id
      const toChainId = currentToChain.id

      const walletConnected = !deps.wallet.userDisconnected && isConnected()

      const balanceExceeded = deps.resultsContainer.dataset.balanceExceeded === 'true'

      const confirmationOpts = !walletConnected
        ? {
            canConfirm: false,
            confirmDisabledReason: 'connect wallet to confirm',
            onConfirmBlocked: () => {
              deps.wallet.userDisconnected = false
              openConnectModal()
            },
          }
        : balanceExceeded
          ? {
              canConfirm: false,
              confirmDisabledReason: 'insufficient balance to confirm',
            }
          : undefined

      const effectiveRcpt = deps.state.agentRecipient
      const currentAddr = (getAddress() ?? '').toLowerCase()
      const isCrossAddress = !!effectiveRcpt && effectiveRcpt.toLowerCase() !== currentAddr
      const confirmed = await deps.showConfirmation(
        route,
        tokenSymbol,
        fromChainId,
        toChainId,
        {
          ...confirmationOpts,
          ...(isCrossAddress ? { recipient: effectiveRcpt, recipientName: deps.state.agentRecipientName } : {}),
        },
      )
      if (!confirmed) return

      // If wallet wasn't connected, we intentionally block execution.
      if (!walletConnected) return

      const userAddress = getAddress()
      if (!userAddress) return

      // Only now: block route refreshes and proceed with execution.
      deps.state.status = 'executing'

      if (isExpired(route)) {
        renderError(deps.resultsContainer, 'Quote expired while reviewing. Fetching new routes...')
        deps.scheduleQuote()
        return
      }

      if (!isOnChain(fromChainId)) {
        const chainName = chainById.get(fromChainId)?.name ?? `chain ${fromChainId}`
        showStatus(`Switching to ${chainName}...`)
        const switched = await switchChain(fromChainId)
        if (!switched) {
          showStatus(`Please switch to ${chainName} in your wallet.`)
          return
        }
      }

      clearChildren(deps.resultsContainer)
      deps.statusContainer.style.display = ''

      deps.resetBtn.classList.add('disabled')
      deps.setPickersDisabled(true)

      clearChildren(deps.statusContainer)
      
      // Status message at top ("Sending [icon] ETH...")
      const statusMsg = document.createElement('div')
      statusMsg.className = 'status-msg'
      
      // Chain icons row
      const fromChain = chainById.get(fromChainId)
      const toChain = chainById.get(toChainId)
      const chainsRow = document.createElement('div')
      chainsRow.className = 'status-hero-chains'

      const fromIcon = document.createElement('img')
      fromIcon.className = 'status-chain-icon'
      fromIcon.src = fromChain?.icon ?? ''
      fromIcon.alt = fromChain?.name ?? ''
      fromIcon.onerror = () => { fromIcon.style.display = 'none' }

      const arrow = document.createElement('span')
      arrow.className = 'status-chain-arrow'
      // Two overlapping arrows: dim base + animated bright overlay
      const arrowDim = document.createElement('span')
      arrowDim.className = 'arrow-dim'
      setTrustedSvg(arrowDim, iconArrowRightLong(28, 12))
      const arrowBright = document.createElement('span')
      arrowBright.className = 'arrow-bright'
      setTrustedSvg(arrowBright, iconArrowRightLong(28, 12))
      arrow.append(arrowDim, arrowBright)

      const toIcon = document.createElement('img')
      toIcon.className = 'status-chain-icon'
      toIcon.src = toChain?.icon ?? ''
      toIcon.alt = toChain?.name ?? ''
      toIcon.onerror = () => { toIcon.style.display = 'none' }

      chainsRow.append(fromIcon, arrow, toIcon)

      // Provider icon row ("via [icon] Provider")
      const providerRow = document.createElement('div')
      providerRow.className = 'status-provider-row'
      const providerIconUrl = PROVIDER_ICONS[route.provider]
      const viaText = document.createElement('span')
      viaText.className = 'status-provider-via'
      viaText.textContent = 'via'
      providerRow.append(viaText)
      if (providerIconUrl) {
        const pIcon = document.createElement('img')
        pIcon.className = 'status-provider-icon'
        pIcon.src = providerIconUrl
        pIcon.alt = route.provider
        pIcon.onerror = () => { pIcon.style.display = 'none' }
        providerRow.appendChild(pIcon)
      }
      const pName = document.createTextNode(route.provider)
      providerRow.appendChild(pName)

      const stepsWrap = document.createElement('div')
      stepsWrap.className = 'status-steps'

      // Append in order: statusMsg, chainsRow, providerRow, stepsWrap
      deps.statusContainer.append(statusMsg, chainsRow, providerRow, stepsWrap)

      const txHashes: (string | null)[] = route.steps.map(() => null)
      let currentStep = 0
      let failed = false

      const explorerUrl = chainById.get(fromChainId)?.explorerUrl ?? ''

      function updateProgress() {
        renderTxProgress(stepsWrap, route.steps, currentStep, txHashes, explorerUrl, failed)
      }

      showStatus('Waiting for confirmation...')
      updateProgress()

      try {
        const provider = route.provider
        const startedAt = Date.now()

        // Eco has no status API; we use destination balance polling.
        // Capture destination pre-balance before sending so we can detect arrival.
        let ecoPreBalance: string | undefined
        let ecoDestTokenAddress: string | undefined
        if (provider === 'Eco') {
          const destAddr = getTokenAddress(tokenSymbol, toChainId)
          if (destAddr) {
            ecoDestTokenAddress = destAddr
            try {
              ecoPreBalance = (await getTokenBalance(toChainId, destAddr, userAddress)).toString()
            } catch {
              // If balance snapshot fails, tracking will remain pending.
            }
          }
        }

        const commonParams = {
          token: tokenSymbol,
          amount: route.steps[0].amountIn,
          fromChainId,
          toChainId,
          userAddress,
          recipient: deps.state.agentRecipient,
        }

        const result = await deps.executeProvider(provider, commonParams, route, (step) => {
          showStatus(step)
          if (step.includes('Approving')) { currentStep = 0; updateProgress() }
          else if (step.includes('Sending')) { currentStep = 0; updateProgress() }
          else if (step.includes('Waiting for relay') || step.includes('Waiting for')) { currentStep = route.steps.length - 1; updateProgress() }
        })

        const isPending = !result.success && result.pending === true && Boolean(result.txHash)
        const destinationConfirmed = result.success && Boolean(result.destinationTxHash)
        const sourceSubmitted = Boolean(result.txHash) && (destinationConfirmed || result.success || isPending)

        if (sourceSubmitted) {
          txHashes[0] = result.txHash ?? null
          currentStep = destinationConfirmed ? route.steps.length : Math.max(0, route.steps.length - 1)
          updateProgress()

          // Refresh balance after source tx confirms with retry for RPC propagation
          setTimeout(() => deps.updateBalance(), 2_000)
          setTimeout(() => deps.updateBalance(), 5_000)

          if (destinationConfirmed) {
            showBridgeResultModal(true, route, result.txHash, result.destinationTxHash)
          } else {
            showStatus(result.statusText ?? 'Transaction submitted. Waiting for destination confirmation...')
          }

          const fromChain = chainById.get(fromChainId)
          const toChain = chainById.get(toChainId)
          if (result.txHash) {
            const safeExplorerUrl = fromChain ? explorerTxUrl(fromChain.explorerUrl, result.txHash) ?? undefined : undefined
            const destinationExplorerUrl = (result.destinationTxHash && toChain)
              ? explorerTxUrl(toChain.explorerUrl, result.destinationTxHash) ?? undefined
              : undefined
            // Save to history (existing behavior)
            saveTransaction({
              txHash: result.txHash,
              fromChainId,
              toChainId,
              token: tokenSymbol,
              status: destinationConfirmed ? 'COMPLETED' : 'IN-FLIGHT',
              amountIn: route.steps[0]?.amountIn ?? '',
              amountOut: route.amountReceived,
              provider,
              timestamp: Date.now(),
              explorerUrl: safeExplorerUrl,
              destinationTxHash: result.destinationTxHash,
              destinationExplorerUrl,
            })

            if (!destinationConfirmed) {
              // Start tracking for status updates until destination confirmation.
              const trackedBridge: TrackedBridge = {
                id: `${result.txHash}-${startedAt}`,
                txHash: result.txHash,
                provider,
                token: tokenSymbol,
                fromChainId,
                toChainId,
                amountIn: route.steps[0]?.amountIn ?? '',
                amountOut: route.amountReceived,
                userAddress,
                status: 'processing',
                startedAt,
                estimatedTime: route.estimatedTime,
                explorerUrl: safeExplorerUrl,
                preBalance: ecoPreBalance,
                destTokenAddress: ecoDestTokenAddress,
                providerOrderId: result.providerOrderId,
              }
              addBridge(trackedBridge)
              trackedRouteById.set(trackedBridge.id, route)
              startPolling(trackedBridge)
              showBridgeInFlightModal(route, result.txHash)
            }

            if (!destinationConfirmed) {
              deps.statusContainer.style.display = 'none'
              clearChildren(deps.statusContainer)
            }
          }
        } else {
          failed = true
          updateProgress()
          showBridgeResultModal(false, route)
        }
      } catch (err: unknown) {
        failed = true
        updateProgress()
        showBridgeResultModal(false, route)
        console.error('[main] bridge error:', err)
      } finally {
        deps.resetBtn.classList.add('visible')
      }
    } finally {
      deps.resetBtn.classList.remove('disabled')
      deps.setPickersDisabled(false)
      bridgeLock = false
      // Reset status if we exited early (cancelled, no wallet, etc.) without completing
      if (deps.state.status === 'executing') {
        deps.state.status = 'idle'
        deps.scheduleQuote()
      }
    }
  }

  return { onBridge }
}
