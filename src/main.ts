// Register service worker only in production. In dev, remove prior registrations
// to avoid stale cached modules breaking Vite HMR/runtime behavior.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // SW registration failure is non-fatal — app works without it
    })
  } else {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {
        // ignore cleanup failures in development
      })

    if ('caches' in window) {
      caches.keys()
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith('ww-')).map((key) => caches.delete(key))))
        .catch(() => {
          // ignore cache cleanup failures in development
        })
    }
  }
}

import './style.css'
import type { AppState } from './core/types'
import { chains, displayTokenSymbol as getDisplaySymbol } from './config/chains'
import { tokens, tokensForChainPair, getTokenDecimals, getTokenAddress, STABLECOINS, NATIVE } from './config/tokens'
import { MAX_BRIDGE_USD } from './config/providers'
import { anyProviderSupportsRoute, getRoutes, prefetchQuoteProviders } from './core/router'
import { createScrollSlot, closeAllPickers, REVERT_SENTINEL, type PickerOption } from './ui/pickers'
import { renderRouteCards, renderSkeleton, renderError, renderNoRouteState } from './ui/results'
import { buildFooter, WEI_SVG } from './ui/footer'
import { createWalletControls } from './ui/wallet-controls'
import { createBridgeFlow } from './ui/bridge-flow'
import {
  isConnected, getAddress,
  subscribeAccount,
} from './wallet/connect'
import { getTokenBalance } from './utils/balance'
import { refreshPrices, getTokenPriceUSD } from './utils/prices'
import { parseAmount } from './utils/parse'
import { parseUrlStateFromHash, applyUrlState, syncUrlHash, clearVolatileUrlParams } from './ui/url-state'
import { resolveRecipient } from './utils/resolve-name'
import { emitAgentRoutes } from './ui/agent-output'
import { setupAgentInputListener } from './ui/agent-input'
import { resumePolling, setBalanceGetter } from './tracking'
import { executeProvider } from './core/provider-executors'
import { formatUnits } from 'viem'
import { clearChildren, setTrustedSvg } from './utils/dom'
import { estimateGasReserveWei } from './utils/gas'
import { showConfirmation } from './ui/confirmation-dialog'


const AMOUNTS: PickerOption[] = [
  { label: '$100', value: '$100' },
  { label: '$75', value: '$75' },
  { label: '$50', value: '$50' },
  { label: '$25', value: '$25' },
  { label: '$10', value: '$10' },
  { label: '···', value: 'custom', editable: true },
  { label: '25%', value: '25%' },
  { label: '50%', value: '50%' },
  { label: '75%', value: '75%' },
  { label: '100%', value: '100%' },
]

const AMOUNTS_PCT_DISABLED: PickerOption[] = AMOUNTS.map(o => {
  if (String(o.value).endsWith('%')) return { ...o, disabled: true }
  return o
})

function amountOptions(): PickerOption[] {
  return isConnected() ? AMOUNTS : AMOUNTS_PCT_DISABLED
}

const state: AppState = {
  amount: '',
  token: null,
  fromChain: null,
  toChain: null,
  routes: null,
  status: 'idle',
  error: null,
}

// Track current balance (raw units) for percentage calculations
let currentBalanceRaw: bigint | null = null
let currentBalanceUSD: number | null = null
let selectedPercentage: number | null = null  // Store selected percentage (25, 50, 75, 100)
let selectedUSDValue: number | null = null     // Store selected USD value ($10, $25, etc.)

let quoteTimer: ReturnType<typeof setTimeout> | null = null
let abortController: AbortController | null = null
const AUTO_REFRESH_INTERVAL = 60_000 // 60 seconds
const MIN_QUOTE_USD = 0.1

function init() {
  // Console notice (neutral, non-technical)
  console.log(
    '%cCAUTION!\n%cIf someone is asking you to copy or paste text here then you are getting scammed.',
    'font-size: 18px; font-weight: 800; line-height: 1.4; color: currentColor;',
    'font-size: 14px; font-weight: 600; line-height: 1.4; color: currentColor;',
  )

  // Restore selections from URL hash (static/IPFS friendly)
  const initialUrlState = parseUrlStateFromHash()
  applyUrlState(initialUrlState, state)
  // Always reset amount & recipient on page load — prevents re-use on refresh
  state.amount = ''
  state.agentRecipient = undefined
  state.agentRecipientName = undefined
  state.agentRecipientNameType = undefined
  state.agentProvider = undefined
  clearVolatileUrlParams()

  // Pre-warm CoinGecko price cache in background — saves ~300ms on first quote
  refreshPrices().catch(() => {})
  // Warm provider modules on idle while keeping startup path lighter.
  prefetchQuoteProviders()

  const app = document.getElementById('app')
  if (!app) {
    throw new Error('Missing #app root element')
  }
  clearChildren(app)

  const skipLink = document.createElement('a')
  skipLink.className = 'skip-link'
  skipLink.href = '#main-content'
  skipLink.textContent = 'Skip to main content'
  app.appendChild(skipLink)

  const container = document.createElement('div')
  container.className = 'container'

  const header = document.createElement('header')
  header.className = 'header'

  const logo = document.createElement('h1')
  logo.className = 'logo'
  logo.textContent = 'which.wei.limo'

  const wallet = createWalletControls()

  header.append(logo, wallet.historyWrap, wallet.connectWrap)

  const sentence = document.createElement('div')
  sentence.className = 'sentence'

  const initialAmountSelected: string | null = selectedPercentage !== null
    ? `${selectedPercentage}%`
    : selectedUSDValue !== null
      ? `$${selectedUSDValue}`
      : state.amount
        ? 'custom'
        : null
  const initialAmountDisplayLabel: string | undefined = (state.amount && selectedPercentage === null && selectedUSDValue === null)
    ? state.amount
    : undefined

  const amountPicker = createScrollSlot({
    options: amountOptions(),
    selected: initialAmountSelected,
    placeholder: '···',
    className: 'amount',
    ariaLabel: 'Amount',
    displayLabel: initialAmountDisplayLabel,
    onSelect: (v, displayLabel) => {
      if (v === 'custom') {
        // Handle revert signal (user scrolled back to editable without selecting)
        if (displayLabel === REVERT_SENTINEL) {
          state.amount = ''
          selectedPercentage = null
          selectedUSDValue = null
          if (quoteTimer) { clearTimeout(quoteTimer); quoteTimer = null }
          if (abortController) { abortController.abort(); abortController = null }
          updateBalance()
          // DON'T call scheduleQuote() here - keep existing cards visible
          // to prevent layout jumping when scrolling through "..."
          // The next valid selection will trigger scheduleQuote
          return
        }
        if (displayLabel) {
          const num = Number(displayLabel)
          if (!Number.isFinite(num) || num <= 0) return // ignore invalid input
          // Keep the user-entered amount as-is.
          // USD limit enforcement happens later in fetchQuotes (based on price).
          state.amount = displayLabel
          selectedPercentage = null  // Clear percentage when custom value is entered
          selectedUSDValue = null
          updateBalance()  // Re-check exceed
          scheduleQuote()
        }
        return
      }
      // Handle percentage values (from % scroll picker)
      if (v.endsWith('%')) {
        const pct = parseInt(v, 10)
        selectedPercentage = pct  // Store for when balance becomes available
        selectedUSDValue = null
        // Don't update picker - scroll already shows correct item
        // Set a placeholder amount so reset button shows
        state.amount = `${pct}%`
        if (currentBalanceRaw !== null && currentBalanceRaw > 0n && state.fromChain && state.token) {
          const decimals = getTokenDecimals(state.token.symbol, state.fromChain.id) ?? 6
          const calculatedRaw = (currentBalanceRaw * BigInt(pct)) / 100n
          state.amount = formatUnits(calculatedRaw, decimals)
        }
        updateBalance()
        scheduleQuote()
        return
      }
      // Handle USD values (from scroll picker)
      if (v.startsWith('$')) {
        const usdValue = parseInt(v.slice(1), 10)
        selectedPercentage = null
        selectedUSDValue = usdValue  // Store for async conversion in fetchQuotes
        // Set a temporary value - will be converted properly in fetchQuotes
        state.amount = String(usdValue)
        updateBalance()
        scheduleQuote()
        return
      }
      selectedPercentage = null
      selectedUSDValue = null  // Clear when custom value entered
      state.amount = v
      updateBalance()  // Re-check exceed
      scheduleQuote()
    },
  })

  function updateAmountPickerOptions() {
    // If disconnected, % has no meaning (no balance) — clear % selection state.
    if (!isConnected() && selectedPercentage !== null) {
      selectedPercentage = null
      state.amount = ''
    }

    let selected: string | null = null
    let displayLabel: string | undefined = undefined

    if (selectedPercentage !== null) {
      selected = `${selectedPercentage}%`
    } else if (selectedUSDValue !== null) {
      selected = `$${selectedUSDValue}`
    } else if (state.amount) {
      selected = 'custom'
      displayLabel = state.amount
    }

    amountPicker.update(amountOptions(), selected, displayLabel)
  }

  const tokenOptions = (): PickerOption[] => {
    if (!state.fromChain || !state.toChain) {
      return tokens.map(t => ({ label: t.symbol, value: t.symbol, icon: t.icon }))
    }
    return tokensForChainPair(state.fromChain.id, state.toChain.id)
      .map(t => ({ label: t.symbol, value: t.symbol, icon: t.icon }))
  }

  const tokenPicker = createScrollSlot({
    options: tokenOptions(),
    selected: state.token?.symbol ?? null,
    placeholder: '···',
    ariaLabel: 'Token',
    onSelect: (v) => {
      state.token = tokens.find(t => t.symbol === v) ?? state.token
      // Clear chain selections if they're no longer valid for this token
      if (state.fromChain && state.token && !(state.fromChain.id in state.token.chains)) {
        state.fromChain = null
      }
      if (state.toChain && state.token && !(state.toChain.id in state.token.chains)) {
        state.toChain = null
      }
      // Update chain pickers to only show chains that support this token
      fromPicker.update(chainOptions('from'), state.fromChain?.id ?? null)
      toPicker.update(chainOptions('to'), state.toChain?.id ?? null)

      // Clear destination if route filtering made it ineligible
      if (state.fromChain && state.toChain && state.token && !anyProviderSupportsRoute(state.token.symbol, state.fromChain.id, state.toChain.id)) {
        state.toChain = null
        toPicker.update(chainOptions('to'), null)
      }
      updateBalance()
      syncUrlHash(state)
      // Only call scheduleQuote sync if NOT waiting for percentage calculation
      if (selectedPercentage === null) {
        scheduleQuote()
      }
    },
  })

  const chainOptions = (kind: 'from' | 'to' = 'from'): PickerOption<number>[] => {
    let available = [...chains]
    const selectedToken = state.token
    const selectedFromChain = state.fromChain
    // Filter by selected token if one is chosen
    if (selectedToken) {
      available = available.filter(c => c.id in selectedToken.chains)
    }

    // Route existence filtering (destination only):
    // once token + source chain are chosen, only show destinations where at
    // least one provider can potentially route.
    if (kind === 'to' && selectedToken && selectedFromChain) {
      available = available.filter(c => c.id === selectedFromChain.id || anyProviderSupportsRoute(selectedToken.symbol, selectedFromChain.id, c.id))
    }

    return available.map(c => ({ label: c.name, value: c.id, icon: c.icon }))
  }

  const fromPicker = createScrollSlot<number>({
    options: chainOptions('from'),
    selected: state.fromChain?.id ?? null,
    placeholder: '···',
    ariaLabel: 'Source chain',
    onSelect: (v) => {
      const oldFrom = state.fromChain
      state.fromChain = chains.find(c => c.id === v) ?? state.fromChain
      const selectedFromChain = state.fromChain
      // Swap direction if user picked the same chain as TO
      if (state.toChain && v === state.toChain.id) {
        state.toChain = oldFrom
        toPicker.update(chainOptions('to'), state.toChain?.id ?? null)
      } else {
        toPicker.update(chainOptions('to'), state.toChain?.id ?? null)
        // Clear destination if it is no longer eligible
        if (state.toChain && state.token && selectedFromChain && !anyProviderSupportsRoute(state.token.symbol, selectedFromChain.id, state.toChain.id)) {
          state.toChain = null
          toPicker.update(chainOptions('to'), null)
        }
      }
      tokenPicker.update(tokenOptions(), state.token?.symbol ?? null)
      updateBalance()
      syncUrlHash(state)
      // Only call scheduleQuote sync if NOT waiting for percentage calculation
      if (selectedPercentage === null) {
        scheduleQuote()
      }
    },
  })

  const toPicker = createScrollSlot<number>({
    options: chainOptions('to'),
    selected: state.toChain?.id ?? null,
    placeholder: '···',
    ariaLabel: 'Destination chain',
    onSelect: (v) => {
      const oldTo = state.toChain
      state.toChain = chains.find(c => c.id === v) ?? state.toChain
      // Swap direction if user picked the same chain as FROM
      if (state.fromChain && v === state.fromChain.id) {
        state.fromChain = oldTo
        fromPicker.update(chainOptions('from'), state.fromChain?.id ?? null)
      } else {
        fromPicker.update(chainOptions('from'), state.fromChain?.id ?? null)
      }
      tokenPicker.update(tokenOptions(), state.token?.symbol ?? null)
      updateBalance()
      syncUrlHash(state)
      // Only call scheduleQuote sync if NOT waiting for percentage calculation
      if (selectedPercentage === null) {
        scheduleQuote()
      }
    },
  })

  // Wrap each half as nowrap so the sentence can only break between halves
  const firstHalf = document.createElement('span')
  firstHalf.style.whiteSpace = 'nowrap'
  firstHalf.append(
    text('Bridge '),
    amountPicker.el,
    text(' '),
    tokenPicker.el,
    text(' '),
  )

  const secondHalf = document.createElement('span')
  secondHalf.style.whiteSpace = 'nowrap'
  secondHalf.append(
    text('from '),
    fromPicker.el,
    text(' to '),
    toPicker.el,
  )

  // Recipient control — declared early so reset/hashchange handlers can reference these elements
  const recipientRow = document.createElement('div')
  recipientRow.className = 'recipient-control'
  const rcLabel = document.createElement('span')
  rcLabel.className = 'rc-label'
  rcLabel.textContent = 'Recipient:'
  const rcNameBadge = document.createElement('span')
  rcNameBadge.className = 'rc-name'
  rcNameBadge.style.display = 'none'
  rcNameBadge.addEventListener('click', () => recipientInput.focus())
  const rcNameIcon = document.createElement('span')
  rcNameIcon.className = 'rc-name-icon'
  rcNameIcon.style.display = 'none'
  const rcNameText = document.createElement('span')
  rcNameBadge.append(rcNameIcon, rcNameText)
  const recipientInput = document.createElement('input')
  recipientInput.className = 'rc-input'
  recipientInput.type = 'text'
  recipientInput.placeholder = '0x/ENS/WNS'
  recipientInput.setAttribute('autocomplete', 'off')
  recipientInput.setAttribute('autocapitalize', 'off')
  recipientInput.setAttribute('spellcheck', 'false')
  recipientInput.setAttribute('aria-label', 'Recipient address')
  const recipientClearBtn = document.createElement('button')
  recipientClearBtn.className = 'rc-clear'
  recipientClearBtn.title = 'Clear recipient'
  recipientClearBtn.setAttribute('aria-label', 'Clear recipient')
  recipientClearBtn.type = 'button'
  setTrustedSvg(recipientClearBtn, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" width="10" height="10"><rect x="0" y="0" width="1" height="1" fill="currentColor"/><rect x="6" y="0" width="1" height="1" fill="currentColor"/><rect x="1" y="1" width="1" height="1" fill="currentColor"/><rect x="5" y="1" width="1" height="1" fill="currentColor"/><rect x="2" y="2" width="1" height="1" fill="currentColor"/><rect x="4" y="2" width="1" height="1" fill="currentColor"/><rect x="3" y="3" width="1" height="1" fill="currentColor"/><rect x="2" y="4" width="1" height="1" fill="currentColor"/><rect x="4" y="4" width="1" height="1" fill="currentColor"/><rect x="1" y="5" width="1" height="1" fill="currentColor"/><rect x="5" y="5" width="1" height="1" fill="currentColor"/><rect x="0" y="6" width="1" height="1" fill="currentColor"/><rect x="6" y="6" width="1" height="1" fill="currentColor"/></svg>')
  const recipientStatusSpan = document.createElement('span')
  recipientStatusSpan.className = 'rc-status'
  let recipientResolveAbort: AbortController | null = null
  function setNameIcon(nameType: 'ens' | 'wns' | undefined, name: string) {
    if (nameType === 'wns') {
      setTrustedSvg(rcNameIcon, WEI_SVG)
      rcNameIcon.title = name
      rcNameIcon.style.display = ''
    } else if (nameType === 'ens') {
      const ensImg = document.createElement('img')
      ensImg.width = 12
      ensImg.height = 12
      ensImg.alt = 'ENS'
      ensImg.src = 'https://static.cx.metamask.io/api/v1/tokenIcons/1/0xc18360217d8f7ab5e7c516566761ea12ce7f9d72.png'
      ensImg.style.cssText = 'border-radius:2px;image-rendering:pixelated;vertical-align:middle'
      ensImg.onerror = () => { ensImg.style.display = 'none' }
      rcNameIcon.replaceChildren(ensImg)
      rcNameIcon.title = name
      rcNameIcon.style.display = ''
    } else {
      rcNameIcon.style.display = 'none'
    }
  }
  function updateRecipientDisplay() {
    if (document.activeElement === recipientInput) return
    const custom = state.agentRecipient
    const userAddr = getAddress()
    if (custom) {
      if (state.agentRecipientName) {
        recipientInput.value = state.agentRecipientName
        recipientInput.title = custom
      } else {
        recipientInput.value = custom.slice(0, 6) + '\u2026' + custom.slice(-4)
        recipientInput.title = custom
      }
      recipientInput.classList.remove('rc-input-self', 'rc-input-error')
      recipientClearBtn.style.display = ''
      rcNameText.textContent = ''
      if (state.agentRecipientName) {
        setNameIcon(state.agentRecipientNameType, state.agentRecipientName)
        rcNameBadge.style.display = ''
      } else {
        rcNameBadge.style.display = 'none'
      }
    } else if (userAddr) {
      recipientInput.value = userAddr.slice(0, 6) + '\u2026' + userAddr.slice(-4)
      recipientInput.title = userAddr
      recipientInput.classList.add('rc-input-self')
      recipientInput.classList.remove('rc-input-error')
      recipientClearBtn.style.display = 'none'
      rcNameText.textContent = ''
      rcNameBadge.style.display = 'none'
    } else {
      recipientInput.value = ''
      recipientInput.title = ''
      recipientInput.classList.remove('rc-input-self', 'rc-input-error')
      recipientClearBtn.style.display = 'none'
      rcNameBadge.style.display = 'none'
    }
  }
  // Reset button — pixel-art X, centered above sentence
  const resetBtn = document.createElement('button')
  resetBtn.className = 'reset-btn'
  resetBtn.title = 'Reset'
  resetBtn.setAttribute('aria-label', 'Reset form')
  setTrustedSvg(resetBtn, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" width="10" height="10"><rect x="0" y="0" width="1" height="1" fill="currentColor"/><rect x="6" y="0" width="1" height="1" fill="currentColor"/><rect x="1" y="1" width="1" height="1" fill="currentColor"/><rect x="5" y="1" width="1" height="1" fill="currentColor"/><rect x="2" y="2" width="1" height="1" fill="currentColor"/><rect x="4" y="2" width="1" height="1" fill="currentColor"/><rect x="3" y="3" width="1" height="1" fill="currentColor"/><rect x="2" y="4" width="1" height="1" fill="currentColor"/><rect x="4" y="4" width="1" height="1" fill="currentColor"/><rect x="1" y="5" width="1" height="1" fill="currentColor"/><rect x="5" y="5" width="1" height="1" fill="currentColor"/><rect x="0" y="6" width="1" height="1" fill="currentColor"/><rect x="6" y="6" width="1" height="1" fill="currentColor"/></svg>')
  resetBtn.addEventListener('click', () => {
    closeAllPickers()
    state.amount = ''
    state.token = null
    state.fromChain = null
    state.toChain = null
    state.routes = null
    state.status = 'idle'
    state.error = null
    if (quoteTimer) { clearTimeout(quoteTimer); quoteTimer = null }
    if (abortController) { abortController.abort(); abortController = null }
    if (clearResultsTimer) { clearTimeout(clearResultsTimer); clearResultsTimer = null }
    amountPicker.update(amountOptions(), null)
    tokenPicker.update(tokenOptions(), null)
    fromPicker.update(chainOptions('from'), null)
    toPicker.update(chainOptions('to'), null)
    clearChildren(resultsContainer)
    clearChildren(statusContainer)
    container.classList.remove('has-results')
    document.documentElement.classList.remove('mobile-all-routes-open')
    document.body.classList.remove('mobile-all-routes-open')
    app.classList.remove('mobile-all-routes-open')
    currentBalanceRaw = null
    currentBalanceUSD = null
    selectedPercentage = null
    selectedUSDValue = null
    balanceEl.textContent = ''
    balanceEl.classList.remove('balance-exceed')
    sentence.classList.remove('compact')
    resetBtn.classList.remove('visible')
    if (recipientResolveAbort) recipientResolveAbort.abort()
    state.agentRecipient = undefined
    state.agentRecipientName = undefined
    state.agentRecipientNameType = undefined
    recipientInput.value = ''
    recipientInput.classList.remove('rc-input-error')
    recipientStatusSpan.textContent = ''
    recipientClearBtn.style.display = 'none'
    syncUrlHash(state)
  })

  sentence.append(resetBtn, firstHalf, secondHalf)

  // Balance display — shows FROM chain token balance under the sentence
  const balanceEl = document.createElement('div')
  balanceEl.className = 'balance-line'

  let balanceAbort: AbortController | null = null
  let balanceRequestId = 0

  async function updateBalance(connectedOverride?: boolean) {
    const requestId = ++balanceRequestId

    // Clear previous
    balanceEl.textContent = ''
    balanceEl.classList.remove('balance-exceed')
    balanceEl.classList.remove('balance-empty')
    balanceEl.classList.remove('balance-loading')
    currentBalanceRaw = null

    // Show connect wallet prompt when selections are made but wallet not connected
    const connected = connectedOverride ?? isConnected()
    if (!connected) {
      if (state.fromChain || state.token || state.amount) {
        balanceEl.textContent = 'connect wallet to bridge'
      }
      return
    }

    if (!state.fromChain || !state.token) {
      return
    }

    const addr = getAddress()
    if (!addr) return

    const chainId = state.fromChain.id
    const tokenSymbol = state.token.symbol
    const displayTokenSymbol = getDisplaySymbol(tokenSymbol, chainId)
    const tokenAddr = getTokenAddress(tokenSymbol, chainId)
    if (!tokenAddr) return

    const decimals = getTokenDecimals(tokenSymbol, chainId) ?? 6

    // Cancel any in-flight balance fetch
    if (balanceAbort) balanceAbort.abort()
    balanceAbort = new AbortController()

    balanceEl.textContent = 'fetching balance…'
    balanceEl.classList.add('balance-loading')

    try {
      const raw = await getTokenBalance(chainId, tokenAddr, addr)

      // Ignore stale responses (e.g. wallet disconnected or selections changed mid-flight)
      if (requestId !== balanceRequestId) return
      if (!(connectedOverride ?? isConnected())) return
      if (!state.fromChain || state.fromChain.id !== chainId) return
      if (!state.token || state.token.symbol !== tokenSymbol) return
      if (getAddress() !== addr) return

      currentBalanceRaw = raw  // Store for percentage calculations

      balanceEl.classList.remove('balance-loading')
      
      // Apply stored percentage if selected before balance was available
      if (selectedPercentage !== null) {
        let calculatedRaw = (raw * BigInt(selectedPercentage)) / 100n
        // Reserve gas for native token
        if (tokenAddr.toLowerCase() === NATIVE.toLowerCase()) {
          try {
            const reserve = await estimateGasReserveWei(chainId)
            calculatedRaw = calculatedRaw - reserve
            if (calculatedRaw < 0n) calculatedRaw = 0n
          } catch { /* fallthrough — use full amount */ }
        }
        state.amount = formatUnits(calculatedRaw, decimals)
      }
      
      const displayDec = STABLECOINS.has(tokenSymbol.toUpperCase()) ? 3 : 5
      const trimDecimalZeros = (v: string) => v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v
      const fullBal = formatUnits(raw, decimals)
      const balNum = Number(fullBal)
      const [balWhole, balFrac = ''] = fullBal.split('.')
      const formatted = trimDecimalZeros(balFrac ? `${balWhole}.${balFrac.slice(0, displayDec)}` : balWhole)

      const price = await getTokenPriceUSD(tokenSymbol, chainId)
      const hasValidPrice = typeof price === 'number' && Number.isFinite(price) && price > 0
      const isStable = STABLECOINS.has(tokenSymbol.toUpperCase())
      currentBalanceUSD = Number.isFinite(balNum)
        ? (hasValidPrice ? (balNum * price) : (isStable ? balNum : 0))
        : 0

      const renderBalanceLabel = (prefix: 'balance:' | 'select:', amount: string) => {
        balanceEl.textContent = ''
        balanceEl.append(document.createTextNode(`${prefix} ${amount}\u00A0`))

        const tokenWrap = document.createElement('span')
        tokenWrap.className = 'balance-token-wrap'
        tokenWrap.style.display = 'inline-flex'
        tokenWrap.style.alignItems = 'center'

        if (state.token?.icon) {
          const tokenIcon = document.createElement('img')
          tokenIcon.src = state.token.icon
          tokenIcon.alt = displayTokenSymbol
          tokenIcon.className = 'balance-token-icon'
          if (displayTokenSymbol === 'USDC' || displayTokenSymbol === 'USDT' || displayTokenSymbol === 'USDT0') {
            tokenIcon.classList.add('balance-token-icon-stable')
          }
          tokenIcon.width = 13
          tokenIcon.height = 13
          tokenIcon.onerror = () => { tokenIcon.style.display = 'none' }
          tokenWrap.append(tokenIcon)
        }

        const tokenText = document.createElement('span')
        tokenText.className = 'balance-token-symbol'
        tokenText.textContent = displayTokenSymbol
        tokenText.style.marginLeft = '0.16em'
        tokenWrap.append(tokenText)

        balanceEl.append(tokenWrap)
      }

      const isPctBalanceTooLow = selectedPercentage !== null
        && (!Number.isFinite(currentBalanceUSD) || (currentBalanceUSD ?? 0) < MIN_QUOTE_USD)

      let isAmountTooLow = false
      if (state.amount) {
        let amountNum = Number(state.amount)
        if (!Number.isFinite(amountNum)) {
          try {
            const amountRaw = BigInt(parseAmount(state.amount, decimals))
            amountNum = Number(formatUnits(amountRaw, decimals))
          } catch {
            amountNum = NaN
          }
        }
        const amountUSD = hasValidPrice ? amountNum * price : amountNum
        isAmountTooLow = Number.isFinite(amountUSD) && amountUSD > 0 && amountUSD < MIN_QUOTE_USD
      }
      
      // Show balance and calculated amount when percentage is active
      if (isPctBalanceTooLow) {
        balanceEl.textContent = `balance too low: ${formatted}`
      } else if (isAmountTooLow) {
        balanceEl.textContent = 'amount too low'
      } else if (selectedPercentage !== null && state.amount) {
        let amtFormatted = state.amount
        try {
          const amtRaw = BigInt(parseAmount(state.amount, decimals))
          const fullAmt = formatUnits(amtRaw, decimals)
          const [amtWhole, amtFrac = ''] = fullAmt.split('.')
          amtFormatted = trimDecimalZeros(amtFrac ? `${amtWhole}.${amtFrac.slice(0, displayDec)}` : amtWhole)
        } catch {
          // ignore — fall back to state.amount
        }

        renderBalanceLabel('select:', amtFormatted)
      } else {
        renderBalanceLabel('balance:', formatted)
      }

      // If % is selected but balance is too low, highlight the balance line.
      if (isPctBalanceTooLow) {
        balanceEl.classList.add('balance-empty')
      }
      if (isAmountTooLow) {
        balanceEl.classList.add('balance-empty')
      }

      // Check if entered/selected amount exceeds balance.
      let exceedsBalance = false
      if (state.amount) {
        try {
          let amtRaw = 0n
          if (selectedUSDValue !== null) {
            if (hasValidPrice) {
              const tokenAmount = selectedUSDValue / price
              const maxDp = Math.min(decimals, 8)
              const normalized = tokenAmount.toFixed(maxDp).replace(/\.?0+$/, '') || '0'
              amtRaw = BigInt(parseAmount(normalized, decimals))
            }
          } else {
            amtRaw = BigInt(parseAmount(state.amount, decimals))
          }
          exceedsBalance = amtRaw > raw
        } catch {
          exceedsBalance = false
        }
      }
      if (exceedsBalance) {
        balanceEl.classList.add('balance-exceed')
        resultsContainer.dataset.balanceExceeded = 'true'
      } else {
        balanceEl.classList.remove('balance-exceed')
        delete resultsContainer.dataset.balanceExceeded
      }
      
      // Always try to schedule quote after balance fetch completes
      scheduleQuote()
    } catch (err) {
      // Silently fail — don't show balance if RPC is unreachable
      console.warn('[balance] fetch failed:', err)
      balanceEl.classList.remove('balance-loading')
      balanceEl.textContent = ''
    }
  }

  const resultsContainer = document.createElement('div')
  resultsContainer.className = 'results-area'
  resultsContainer.setAttribute('aria-live', 'polite')
  resultsContainer.setAttribute('aria-atomic', 'false')
  resultsContainer.setAttribute('aria-labelledby', 'route-results-heading')

  const statusContainer = document.createElement('div')
  statusContainer.className = 'status-container'
  statusContainer.style.display = 'none'

  // Recipient input handlers
  function setRecipientFromInput(raw: string): void {
    if (recipientResolveAbort) recipientResolveAbort.abort()
    const trimmed = raw.trim()
    const currentKnown = state.agentRecipientName ?? state.agentRecipient ?? ''
    if (trimmed === currentKnown && trimmed !== '') { updateRecipientDisplay(); return }
    if (!trimmed) {
      state.agentRecipient = undefined
      state.agentRecipientName = undefined
      state.agentRecipientNameType = undefined
      recipientInput.classList.remove('rc-input-error')
      recipientStatusSpan.textContent = ''
      updateRecipientDisplay()
      syncUrlHash(state)
      scheduleQuote()
      return
    }
    recipientStatusSpan.textContent = 'resolving\u2026'
    recipientInput.classList.remove('rc-input-error')
    recipientResolveAbort = new AbortController()
    const snap = recipientResolveAbort
    void resolveRecipient(trimmed).then((resolved) => {
      if (snap.signal.aborted) return
      const walletAddr = getAddress()
      if (walletAddr && resolved.address.toLowerCase() === walletAddr.toLowerCase()) {
        state.agentRecipient = undefined
        state.agentRecipientName = undefined
        state.agentRecipientNameType = undefined
      } else {
        state.agentRecipient = resolved.address
        state.agentRecipientName = resolved.name
        state.agentRecipientNameType = resolved.nameType
      }
      recipientInput.classList.remove('rc-input-error')
      recipientStatusSpan.textContent = ''
      updateRecipientDisplay()
      syncUrlHash(state)
      scheduleQuote()
    }).catch(() => {
      if (snap.signal.aborted) return
      state.agentRecipient = undefined
      state.agentRecipientName = undefined
      state.agentRecipientNameType = undefined
      recipientInput.classList.add('rc-input-error')
      recipientStatusSpan.textContent = '? not found'
      syncUrlHash(state)
      scheduleQuote()
    })
  }

  recipientInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setRecipientFromInput(recipientInput.value) }
    if (e.key === 'Escape') { recipientInput.value = ''; setRecipientFromInput('') }
  })
  recipientInput.addEventListener('focus', () => {
    recipientStatusSpan.textContent = ''
    if (state.agentRecipient) {
      recipientInput.value = state.agentRecipientName ?? state.agentRecipient
    } else {
      recipientInput.value = ''
    }
    recipientInput.classList.remove('rc-input-self')
    recipientInput.select()
  })
  recipientInput.addEventListener('blur', () => {
    const val = recipientInput.value.trim()
    if (!val && !state.agentRecipient) { updateRecipientDisplay(); return }
    const current = state.agentRecipientName ?? state.agentRecipient ?? ''
    if (val && val === current) { updateRecipientDisplay(); return }
    setRecipientFromInput(val)
  })
  recipientClearBtn.addEventListener('click', () => { recipientInput.value = ''; setRecipientFromInput('') })
  const rcField = document.createElement('div')
  rcField.className = 'rc-field'
  rcField.append(rcNameBadge, recipientInput)
  recipientRow.append(rcLabel, rcField, recipientClearBtn, recipientStatusSpan)

  const footer = buildFooter({
    chains,
    getFromChainId: () => state.fromChain?.id ?? 1,
    onRpcChange: () => { updateBalance(); scheduleQuote() },
  })

  const mainStack = document.createElement('main')
  mainStack.id = 'main-content'
  mainStack.tabIndex = -1
  mainStack.className = 'main-stack'

  const bridgeHeading = document.createElement('h2')
  bridgeHeading.className = 'sr-only'
  bridgeHeading.textContent = 'Bridge form'

  const resultsHeading = document.createElement('h2')
  resultsHeading.id = 'route-results-heading'
  resultsHeading.className = 'sr-only'
  resultsHeading.textContent = 'Route results'

  mainStack.append(bridgeHeading, sentence, balanceEl, resultsHeading, resultsContainer, statusContainer)

  container.append(header, mainStack, footer)
  app.appendChild(container)

  // Initialize bridge order tracking
  setBalanceGetter(async (chainId, tokenAddress, address) => {
    // Simple balance getter for Eco tracking
    try {
      const balance = await getTokenBalance(chainId, tokenAddress, address as `0x${string}`)
      return balance ?? 0n
    } catch {
      return 0n
    }
  })
  resumePolling() // Resume tracking for any pending bridges

  // Apply hash changes (e.g. user pasted a URL)
  window.addEventListener('hashchange', () => {
    closeAllPickers()
    if (recipientResolveAbort) recipientResolveAbort.abort()
    state.agentRecipient = undefined
    state.agentRecipientName = undefined
    state.agentRecipientNameType = undefined
    state.agentProvider = undefined
    recipientInput.value = ''
    recipientInput.classList.remove('rc-input-error')
    recipientStatusSpan.textContent = ''
    recipientClearBtn.style.display = 'none'
    const nextUrlState = parseUrlStateFromHash()
    applyUrlState(nextUrlState, state)
    clearVolatileUrlParams()
    updateAmountPickerOptions()
    if (nextUrlState.amount) {
      amountPicker.update(amountOptions(), 'custom', state.amount)
    }
    tokenPicker.update(tokenOptions(), state.token?.symbol ?? null)
    fromPicker.update(chainOptions('from'), state.fromChain?.id ?? null)
    toPicker.update(chainOptions('to'), state.toChain?.id ?? null)
    updateBalance()
    if (nextUrlState.recipient) {
      void (async () => {
        try {
          const resolved = await resolveRecipient(nextUrlState.recipient!)
          state.agentRecipient = resolved.address
          state.agentRecipientName = resolved.name
          recipientInput.value = resolved.name ?? resolved.address
          updateRecipientDisplay()
        } catch { /* silently ignore */ }
        scheduleQuote()
      })()
    } else {
      scheduleQuote()
    }
  })

  // Subscribe to wallet state changes — must be after DOM elements are created
  subscribeAccount((acctState) => {
    wallet.updateWalletButton()
    wallet.updateHistoryButton()
    updateAmountPickerOptions()
    syncUrlHash(state)
    if (acctState.isConnected && !wallet.userDisconnected) {
      scheduleQuote()
      updateBalance(true)
    } else {
      updateRecipientDisplay()
      updateBalance(false)
    }
  })

  function updateResetVisibility() {
    const hasInput = !!(state.amount || state.token || state.fromChain || state.toChain)
    resetBtn.classList.toggle('visible', hasInput)
  }

  // Timer for debounced clearing of results (prevents layout jumping during scroll)
  let clearResultsTimer: ReturnType<typeof setTimeout> | null = null
  const CLEAR_RESULTS_DEBOUNCE_MS = 350  // Longer than scroll settle to prevent jumping

  function clearResultsDebounced(message: string) {
    // If there are existing routes, keep them visible during the debounce period
    const existingRoutes = resultsContainer.querySelector('.routes') as HTMLElement | null
    if (existingRoutes) {
      existingRoutes.dataset.loading = 'true'  // Show loading state on existing cards
    }
    
    if (clearResultsTimer) clearTimeout(clearResultsTimer)
    clearResultsTimer = setTimeout(() => {
      resultsContainer.textContent = ''
      if (message) {
        const loading = document.createElement('div')
        loading.className = 'loading'
        loading.textContent = message
        resultsContainer.appendChild(loading)
      }
      sentence.classList.remove('compact')
      container.classList.remove('has-results')
    }, CLEAR_RESULTS_DEBOUNCE_MS)
  }

  function cancelClearResults() {
    if (clearResultsTimer) {
      clearTimeout(clearResultsTimer)
      clearResultsTimer = null
    }
  }

  function scheduleQuote() {
    if (quoteTimer) clearTimeout(quoteTimer)
    if (abortController) abortController.abort()
    if (state.status === 'executing') return
    updateResetVisibility()
    syncUrlHash(state)

    // Need all selections filled
    if (!state.amount || !state.token || !state.fromChain || !state.toChain) {
      clearResultsDebounced('')
      return
    }

    const srcDecimals = getTokenDecimals(state.token.symbol, state.fromChain.id) ?? 6

    // If using a % amount, wait for balance and handle low-balance explicitly.
    if (selectedPercentage !== null) {
      if (currentBalanceRaw === null || currentBalanceUSD === null) {
        cancelClearResults()
        state.routes = null
        state.status = 'idle'
        delete resultsContainer.dataset.balanceExceeded
        // If routes were showing, keep skeleton in place to prevent layout jump
        if (container.classList.contains('has-results')) {
          renderSkeleton(resultsContainer)
        } else {
          clearChildren(resultsContainer)
          sentence.classList.remove('compact')
          container.classList.remove('has-results')
        }
        return
      }
      if (!Number.isFinite(currentBalanceUSD) || currentBalanceUSD < MIN_QUOTE_USD) {
        cancelClearResults()
        state.routes = null
        state.status = 'idle'
        delete resultsContainer.dataset.balanceExceeded
        clearChildren(resultsContainer)
        sentence.classList.remove('compact')
        container.classList.remove('has-results')
        return
      }
    }

    // Skip if amount is effectively zero
    try {
      const amountRaw = BigInt(parseAmount(state.amount, srcDecimals))
      if (amountRaw <= 0n) {
        clearResultsDebounced('Enter an amount to bridge')
        return
      }
    } catch {
      clearResultsDebounced('Enter a valid amount to bridge')
      return
    }

    if (state.fromChain.id === state.toChain.id) {
      clearResultsDebounced('Same chain — no bridge needed.')
      return
    }

    // Valid state - cancel any pending clear and proceed with quote
    cancelClearResults()

    // If routes are currently displayed, pause their TTL and show a stable loading state
    const existingRoutes = resultsContainer.querySelector('.routes') as HTMLElement | null
    if (existingRoutes) existingRoutes.dataset.loading = 'true'

    const QUOTE_DEBOUNCE_MS = 200
    quoteTimer = setTimeout(() => fetchQuotes(), QUOTE_DEBOUNCE_MS)
  }

  async function fetchQuotes() {
    abortController = new AbortController()
    // Keep the amount picker open if the user is actively typing in the custom input.
    // Closing it mid-typing causes the picker to disappear/jump when route cards mount/unmount.
    const activeEl = document.activeElement as HTMLElement | null
    if (!activeEl?.classList?.contains('picker-input')) {
      closeAllPickers()  // Close any open pickers before sentence moves
    }
    state.status = 'loading'
    wallet.showLoading()

    const token = state.token
    const fromChain = state.fromChain
    const toChain = state.toChain
    if (!token || !fromChain || !toChain) {
      state.status = 'idle'
      wallet.hideLoading()
      return
    }

    // Render skeleton for loading state
    renderSkeleton(resultsContainer)
    const sViewAll = resultsContainer.querySelector('.view-all-btn')
    if (sViewAll?.parentNode) sViewAll.after(recipientRow)
    updateRecipientDisplay()
    sentence.classList.add('compact')
    container.classList.add('has-results')

    try {
      const tokenPrice = await getTokenPriceUSD(token.symbol, fromChain.id)
      if (selectedUSDValue !== null && tokenPrice !== null && tokenPrice > 0) {
        const tokenAmount = selectedUSDValue / tokenPrice
        const srcDecimals = getTokenDecimals(token.symbol, fromChain.id) ?? 6
        const maxDp = Math.min(srcDecimals, 8)
        state.amount = tokenAmount.toFixed(maxDp).replace(/\.?0+$/, '')
      }

      // Check if amount exceeds MAX_BRIDGE_USD in USD terms
      const srcDecimals = getTokenDecimals(token.symbol, fromChain.id) ?? 6
      let amountNum = Number(state.amount)
      if (!Number.isFinite(amountNum)) {
        try {
          const raw = BigInt(parseAmount(state.amount, srcDecimals))
          amountNum = Number(formatUnits(raw, srcDecimals))
        } catch {
          amountNum = NaN
        }
      }
      const amountUSD = tokenPrice !== null ? amountNum * tokenPrice : amountNum // fallback to 1:1
      if (!Number.isFinite(amountUSD) || amountUSD < MIN_QUOTE_USD) {
        clearChildren(resultsContainer)
        sentence.classList.remove('compact')
        container.classList.remove('has-results')
        state.status = 'idle'
        return
      }
      if (amountUSD > MAX_BRIDGE_USD) {
        clearChildren(resultsContainer)
        sentence.classList.remove('compact')
        container.classList.remove('has-results')
        balanceEl.textContent = `amount exceeds $${MAX_BRIDGE_USD} limit`
        balanceEl.classList.add('balance-empty')
        state.status = 'error'
        return
      }

      const destDecimals = getTokenDecimals(token.symbol, toChain.id) ?? 6
      const amountRaw = parseAmount(state.amount, srcDecimals)

      const result = await getRoutes({
        amount: amountRaw,
        token,
        fromChain,
        toChain,
        userAddress: getAddress() ?? '0x0000000000000000000000000000000000000000',
        recipient: state.agentRecipient,
      }, abortController.signal, undefined, state.agentProvider)

      state.routes = result
      state.status = 'results'

      if (!result.fastest && !result.cheapest) {
        emitAgentRoutes([], 'no-routes')
        renderNoRouteState(resultsContainer, () => scheduleQuote())
        return
      }

      const wrapper = document.createElement('div')
      wrapper.className = 'routes'
      renderRouteCards(
        wrapper,
        result.fastest,
        result.cheapest,
        result.allRoutes,
        token.symbol,
        destDecimals,
        token.icon,
        (route) => onBridge(route),
        () => scheduleQuote(),
        amountUSD,
      )
      clearChildren(resultsContainer)
      const viewAllBtn = wrapper.querySelector('.view-all-btn')
      if (viewAllBtn?.parentNode) {
        viewAllBtn.after(recipientRow)
      } else {
        wrapper.appendChild(recipientRow)
      }
      updateRecipientDisplay()
      resultsContainer.appendChild(wrapper)
      sentence.classList.add('compact')
      container.classList.add('has-results')
      emitAgentRoutes(result.allRoutes, 'ready')

      // Auto-refresh quotes
      quoteTimer = setTimeout(() => scheduleQuote(), AUTO_REFRESH_INTERVAL)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return // ignore aborted fetches
      state.status = 'error'
      const msg = err instanceof TypeError
        ? 'Network error — check your connection and try again.'
        : 'Failed to fetch routes. Please try again.'
      renderError(resultsContainer, msg)
      emitAgentRoutes([], 'error')
      console.error('[main] quote error:', err)
    } finally {
      wallet.hideLoading()
    }
  }

  const { onBridge } = createBridgeFlow({
    state,
    wallet,
    resultsContainer,
    statusContainer,
    resetBtn,
    scheduleQuote,
    updateBalance,
    setPickersDisabled: (disabled: boolean) => {
      amountPicker.setDisabled(disabled)
      tokenPicker.setDisabled(disabled)
      fromPicker.setDisabled(disabled)
      toPicker.setDisabled(disabled)
    },
    showConfirmation,
    executeProvider,
  })

  // Agent integration — select route via custom event
  setupAgentInputListener((providerName) => {
    const match = state.routes?.allRoutes.find(
      r => r.provider.toLowerCase().replace(/[\s.]+/g, '-') === providerName,
    )
    if (match) onBridge(match)
  })

  // Initial load — amount & recipient are always reset on refresh
  scheduleQuote()
}

function text(s: string): Text {
  return document.createTextNode(s)
}

init()
