import {
  openConnectModal, isConnected, getAddress,
  disconnect,
} from '../wallet/connect'
import { chains, displayTokenSymbol } from '../config/chains'
import { tokenBySymbol } from '../config/tokens'
import { truncateAddress, formatToken, formatUSD } from '../utils/format'
import { clearHistory, renderHistoryList } from './history'
import { clearChildren, setTrustedSvg } from '../utils/dom'
import { getTokenBalance } from '../utils/balance'
import { getTokenPriceUSD } from '../utils/prices'
import { formatUnits } from 'viem'
import { iconClaim, iconRefresh, iconTrash } from './icons'
import { BRIDGE_UPDATE_EVENT } from '../tracking/manager'
import { getActiveBridges } from '../tracking/store'
import { setTrustedSvg as setTrustedSvgWallet } from '../utils/dom'

export interface WalletControls {
  connectWrap: HTMLSpanElement
  historyWrap: HTMLSpanElement
  updateWalletButton(): void
  updateHistoryButton(): void
  showLoading(): void
  hideLoading(): void
  get userDisconnected(): boolean
  set userDisconnected(v: boolean)
}

export function createWalletControls(): WalletControls {
  let userDisconnected = false

  // Wrapper for relative positioning of dropdown
  const connectWrap = document.createElement('span')
  connectWrap.className = 'connect-wrap'

  const connectBtn = document.createElement('button')
  connectBtn.className = 'connect-btn'
  connectBtn.setAttribute('aria-label', 'Connect wallet')
  connectBtn.textContent = '[connect]'

  const balanceSpinner = document.createElement('span')
  balanceSpinner.className = 'wallet-balance-spinner'

  let loadingRefCount = 0
  function showLoading() {
    loadingRefCount++
    balanceSpinner.classList.add('visible')
  }
  function hideLoading() {
    loadingRefCount = Math.max(0, loadingRefCount - 1)
    if (loadingRefCount === 0) balanceSpinner.classList.remove('visible')
  }

  const refreshBalancesBtn = document.createElement('button')
  refreshBalancesBtn.className = 'wallet-refresh-btn refresh-btn'
  refreshBalancesBtn.title = 'Refresh balances'
  refreshBalancesBtn.setAttribute('aria-label', 'Refresh balances')
  setTrustedSvg(refreshBalancesBtn, iconRefresh(16))

  // Wallet dropdown tooltip (disconnect + balances)
  const walletTooltip = document.createElement('div')
  walletTooltip.className = 'wallet-tooltip'

  const tooltipControls = document.createElement('div')
  tooltipControls.className = 'wallet-tooltip-controls'
  tooltipControls.append(refreshBalancesBtn)

  const balancesBox = document.createElement('div')
  balancesBox.className = 'wallet-tooltip-box'

  const balancesList = document.createElement('div')
  balancesList.className = 'wallet-tooltip-list'

  const balancesChevron = document.createElement('div')
  balancesChevron.className = 'wallet-tooltip-chevron'
  balancesChevron.setAttribute('aria-hidden', 'true')

  function updateWalletChevronVisibility() {
    const canScroll = balancesBox.scrollHeight > balancesBox.clientHeight + 1
    const atEnd = balancesBox.scrollTop + balancesBox.clientHeight >= balancesBox.scrollHeight - 1
    balancesChevron.classList.toggle('visible', canScroll && !atEnd)
  }
  
  function setBalancesStatus(text: string) {
    clearChildren(balancesList)
    const status = document.createElement('div')
    status.className = 'wallet-tooltip-status'
    status.textContent = text
    balancesList.appendChild(status)
    requestAnimationFrame(updateWalletChevronVisibility)
  }

  function renderBalanceSkeleton(rows = 5) {
    clearChildren(balancesList)
    for (let index = 0; index < rows; index++) {
      const row = document.createElement('div')
      row.className = 'wallet-balance-row wallet-balance-row-skeleton'

      const left = document.createElement('div')
      left.className = 'wallet-balance-skeleton-left'
      const leftBar = document.createElement('div')
      leftBar.className = 'wallet-balance-skeleton-bar'
      left.appendChild(leftBar)

      const sep = document.createElement('div')
      sep.className = 'wallet-balance-sep'

      const right = document.createElement('div')
      right.className = 'wallet-balance-skeleton-right'
      const rightBar = document.createElement('div')
      rightBar.className = 'wallet-balance-skeleton-bar'
      right.appendChild(rightBar)

      row.append(left, sep, right)
      balancesList.appendChild(row)
    }
    requestAnimationFrame(updateWalletChevronVisibility)
  }

  setBalancesStatus('loading…')

  balancesBox.append(balancesList)
  walletTooltip.append(tooltipControls, balancesBox, balancesChevron)
  balancesBox.addEventListener('scroll', updateWalletChevronVisibility)

  // Keep click-to-open usable: interactions inside the tooltip shouldn't immediately close it.
  walletTooltip.addEventListener('click', (e) => e.stopPropagation())

  connectWrap.append(balanceSpinner, connectBtn, walletTooltip)

  type BalanceRow = {
    chainId: number
    chainName: string
    chainIcon?: string
    tokenIcon?: string
    symbol: 'ETH' | 'USDC' | 'USDT' | 'USDT0'
    raw: bigint
    decimals: number
    amountNum: number
    valueUSD: number
  }

  let balancesInflight: Promise<void> | null = null
  let balancesFetchedAt = 0
  const BALANCE_CACHE_TTL_MS = 180_000
  const BALANCE_FETCH_CONCURRENCY = 4
  let balanceRowsCache: BalanceRow[] | null = null

  async function runWithConcurrency<T>(taskFns: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    if (taskFns.length === 0) return []

    const effectiveLimit = Math.max(1, Math.min(limit, taskFns.length))
    const results = new Array<T>(taskFns.length)
    let nextIndex = 0

    const worker = async () => {
      while (true) {
        const current = nextIndex
        nextIndex += 1
        if (current >= taskFns.length) return
        results[current] = await taskFns[current]()
      }
    }

    await Promise.all(Array.from({ length: effectiveLimit }, () => worker()))
    return results
  }

  function renderBalances(rows: BalanceRow[]) {
    clearChildren(balancesList)
    balanceRowsCache = rows

    if (rows.length === 0) {
      setBalancesStatus('no balances')
      return
    }

    for (const r of rows) {
      const row = document.createElement('div')
      row.className = 'wallet-balance-row'

      const left = document.createElement('div')
      left.className = 'wallet-balance-left'

      const leftText = document.createElement('div')
      leftText.className = 'wallet-balance-left-text'

      if (r.chainIcon) {
        const img = document.createElement('img')
        img.src = r.chainIcon
        img.alt = r.chainName
        img.className = 'wallet-balance-chain-icon'
        img.width = 18
        img.height = 18
        left.appendChild(img)
      }

      const chainName = document.createElement('div')
      chainName.className = 'wallet-balance-chain-name'
      chainName.textContent = r.chainName

      leftText.append(chainName)
      left.append(leftText)

      const right = document.createElement('div')
      right.className = 'wallet-balance-right'

      const primary = document.createElement('div')
      primary.className = 'wallet-balance-primary'

      const value = document.createElement('div')
      value.className = 'wallet-balance-value'
      const maxDecimals = r.symbol === 'ETH' ? 6 : 4
      value.textContent = formatToken(r.raw.toString(), r.decimals, maxDecimals)

      const usdTooltip = Number.isFinite(r.valueUSD) ? formatUSD(r.valueUSD) : '$0.00'
      value.title = usdTooltip

      const tokenWrap = document.createElement('div')
      tokenWrap.className = 'wallet-balance-token-wrap'

      const displaySymbol = displayTokenSymbol(r.symbol, r.chainId)

      const sym = document.createElement('div')
      sym.className = `wallet-balance-symbol${r.symbol === 'ETH' ? ' wallet-balance-symbol-eth' : ''}`
      sym.textContent = displaySymbol

      if (r.tokenIcon) {
        const tokenImg = document.createElement('img')
        tokenImg.src = r.tokenIcon
        tokenImg.alt = displaySymbol
        tokenImg.className = 'wallet-balance-token-icon'
        tokenImg.width = 18
        tokenImg.height = 18
        tokenWrap.append(tokenImg, sym)
      } else {
        tokenWrap.append(sym)
      }

      right.title = usdTooltip

      const usdValue = document.createElement('div')
      usdValue.className = 'wallet-balance-usd'
      usdValue.textContent = usdTooltip

      primary.append(value, tokenWrap)
      right.append(primary, usdValue)

      const sep = document.createElement('div')
      sep.className = 'wallet-balance-sep'

      row.append(left, sep, right)
      balancesList.appendChild(row)
    }

    requestAnimationFrame(updateWalletChevronVisibility)
  }

  async function refreshBalances(force = false): Promise<void> {
    if (!isConnected()) return
    if (userDisconnected) return
    const address = getAddress()
    if (!address) return

    const now = Date.now()
    if (!force && balancesInflight) return
    if (!force && now - balancesFetchedAt < BALANCE_CACHE_TTL_MS) {
      if (balanceRowsCache) renderBalances(balanceRowsCache)
      return
    }

    balancesInflight = (async () => {
      balancesFetchedAt = now
      if (!balanceRowsCache || force) {
        renderBalanceSkeleton()
        showLoading()
        refreshBalancesBtn.style.display = 'none'
        balancesChevron.style.display = 'none'
      }

      const symbols: Array<BalanceRow['symbol']> = ['ETH', 'USDC', 'USDT', 'USDT0']
      const taskFns: Array<() => Promise<BalanceRow | null>> = []

      for (const c of chains) {
        for (const sym of symbols) {
          const token = tokenBySymbol.get(sym)
          const tokenInfo = token?.chains[c.id]
          if (!token || !tokenInfo) continue

          taskFns.push(async () => {
            let rawBal = 0n

            const readBalance = async (tokenAddress: string): Promise<bigint> => {
              try {
                return await getTokenBalance(c.id, tokenAddress, address)
              } catch {
                return 0n
              }
            }

            rawBal = await readBalance(tokenInfo.address)

            // Convert to Number for sorting/display; safe for typical wallet balances.
            const amountStr = formatUnits(rawBal, tokenInfo.decimals)
            const amountNum = Number(amountStr)
            const price = await getTokenPriceUSD(sym, c.id)
            const isStable = sym === 'USDC' || sym === 'USDT' || sym === 'USDT0'
            const hasValidPrice = typeof price === 'number' && Number.isFinite(price) && price > 0
            const valueUSD = Number.isFinite(amountNum)
              ? (hasValidPrice ? (amountNum * price) : (isStable ? amountNum : 0))
              : 0

            // Apply minimum thresholds:
            // - ETH: hide if value < $0.10 (using cached ETH price),
            //        fallback to 0.0001 ETH when price is unavailable.
            // - USDC/USDT: hide if < $0.10
            if (!Number.isFinite(amountNum)) return null
            if (sym === 'ETH') {
              if (hasValidPrice) {
                if (!Number.isFinite(valueUSD) || valueUSD < 0.1) return null
              } else if (amountNum < 0.0001) {
                return null
              }
            } else {
              if (isStable) {
                if (amountNum < 0.1) return null
              } else if (!Number.isFinite(valueUSD) || valueUSD < 0.1) {
                return null
              }
            }

            return {
              chainId: c.id,
              chainName: c.name,
              chainIcon: c.icon,
              tokenIcon: token.icon,
              symbol: sym,
              raw: rawBal,
              decimals: tokenInfo.decimals,
              amountNum: Number.isFinite(amountNum) ? amountNum : 0,
              valueUSD: Number.isFinite(valueUSD) ? valueUSD : 0,
            } satisfies BalanceRow
          })
        }
      }

      const rows = (await runWithConcurrency(taskFns, BALANCE_FETCH_CONCURRENCY)).filter((x): x is BalanceRow => !!x)
      rows.sort((a, b) => b.valueUSD - a.valueUSD)
      renderBalances(rows)
      hideLoading()
      refreshBalancesBtn.style.display = ''
      balancesChevron.style.display = ''
    })()

    try {
      await balancesInflight
    } finally {
      balancesInflight = null
    }
  }

  function updateWalletButton() {
    if (!userDisconnected && isConnected()) {
      const address = getAddress()
      connectWrap.classList.add('connected')
      connectBtn.classList.add('connected')
      connectBtn.textContent = `[${address ? truncateAddress(address) : 'connected'}]`
      connectBtn.setAttribute('aria-label', `Wallet ${address ? truncateAddress(address) : 'connected'}`)
    } else {
      connectWrap.classList.remove('active')
      connectWrap.classList.remove('connected')
      connectBtn.classList.remove('connected')
      connectBtn.classList.remove('disconnect-hover')
      connectBtn.textContent = '[connect]'
      connectBtn.setAttribute('aria-label', 'Connect wallet')
    }
  }

  const canHover = window.matchMedia('(hover: hover)').matches

  connectBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (userDisconnected || !isConnected()) {
      userDisconnected = false
      openConnectModal()
      return
    }
    if (canHover && (connectBtn.classList.contains('disconnect-hover') || connectWrap.matches(':hover'))) {
      connectWrap.classList.remove('active')
      userDisconnected = true
      disconnect()
      updateWalletButton()
      updateHistoryButton()
      return
    }
    // Touch device: toggle balance tooltip
    connectWrap.classList.toggle('active')
    if (connectWrap.classList.contains('active')) {
      void refreshBalances()
    }
  })

  connectWrap.addEventListener('mouseenter', () => {
    if (!userDisconnected && isConnected()) {
      if (canHover) {
        connectBtn.classList.add('disconnect-hover')
        connectBtn.textContent = '[disconnect]'
        connectBtn.setAttribute('aria-label', 'Disconnect wallet')
      }
      void refreshBalances()
    }
  })

  connectWrap.addEventListener('mouseleave', () => {
    if (!userDisconnected && isConnected()) {
      connectBtn.classList.remove('disconnect-hover')
      updateWalletButton()
    }
  })

  refreshBalancesBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void refreshBalances(true)
  })

  // Close dropdown on outside click
  document.addEventListener('click', () => connectWrap.classList.remove('active'))

  updateWalletButton()

  // History text with hover tooltip
  const historyWrap = document.createElement('span')
  historyWrap.className = 'history-wrap hidden'

  const historySpinner = document.createElement('span')
  historySpinner.className = 'history-pending-spinner'

  const historyBtn = document.createElement('button')
  historyBtn.type = 'button'
  historyBtn.className = 'history-btn'
  historyBtn.textContent = 'history'
  historyBtn.setAttribute('aria-haspopup', 'true')
  historyBtn.setAttribute('aria-expanded', 'false')

  const historyTooltip = document.createElement('div')
  historyTooltip.className = 'history-tooltip'

  const historyTooltipControls = document.createElement('div')
  historyTooltipControls.className = 'history-tooltip-controls'

  const historyClearBtn = document.createElement('button')
  historyClearBtn.className = 'history-clear-icon-btn refresh-btn'
  historyClearBtn.title = 'Clear history'
  historyClearBtn.setAttribute('aria-label', 'Clear history')
  setTrustedSvg(historyClearBtn, iconTrash(18))

  const historyScroll = document.createElement('div')
  historyScroll.className = 'history-tooltip-scroll'

  const historyChevron = document.createElement('div')
  historyChevron.className = 'history-tooltip-chevron'
  historyChevron.setAttribute('aria-hidden', 'true')

  function updateHistoryChevronVisibility() {
    const canScroll = historyScroll.scrollHeight > historyScroll.clientHeight + 1
    const atEnd = historyScroll.scrollTop + historyScroll.clientHeight >= historyScroll.scrollHeight - 1
    historyChevron.classList.toggle('visible', canScroll && !atEnd)
  }

  historyTooltipControls.append(historyClearBtn)
  historyTooltip.append(historyTooltipControls, historyScroll, historyChevron)
  historyWrap.append(historySpinner, historyBtn, historyTooltip)
  historyScroll.addEventListener('scroll', updateHistoryChevronVisibility)

  function updateHistoryPendingSpinner() {
    const active = getActiveBridges()
    const hasClaimReady = active.some(b => b.status === 'claim-ready')
    const hasPending = active.some(b => b.status === 'sent' || b.status === 'processing')

    if (hasClaimReady && !hasPending) {
      // Show claim icon instead of spinner when only claim-ready bridges exist
      historySpinner.classList.add('visible')
      historySpinner.classList.add('claim-mode')
      setTrustedSvgWallet(historySpinner, iconClaim(12))
    } else if (hasPending || hasClaimReady) {
      // Pending takes priority — show spinner
      historySpinner.classList.add('visible')
      historySpinner.classList.remove('claim-mode')
      historySpinner.textContent = ''
      historySpinner.innerHTML = ''
    } else {
      historySpinner.classList.remove('visible', 'claim-mode')
      historySpinner.textContent = ''
      historySpinner.innerHTML = ''
    }
  }

  function updateHistoryButton() {
    if (isConnected()) {
      historyWrap.classList.remove('hidden')
    } else {
      historyWrap.classList.add('hidden')
    }
    updateHistoryPendingSpinner()
  }

  function refreshHistoryTooltip() {
    clearChildren(historyScroll)
    historyScroll.appendChild(renderHistoryList())
    requestAnimationFrame(updateHistoryChevronVisibility)
  }

  historyClearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    clearHistory()
    refreshHistoryTooltip()
  })

  historyWrap.addEventListener('mouseenter', () => {
    refreshHistoryTooltip()
  })

  historyBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    historyWrap.classList.toggle('active')
    historyBtn.setAttribute('aria-expanded', historyWrap.classList.contains('active') ? 'true' : 'false')
    if (historyWrap.classList.contains('active')) {
      refreshHistoryTooltip()
    }
  })
  window.addEventListener(BRIDGE_UPDATE_EVENT, (evt) => {
    updateHistoryPendingSpinner()
    if (historyWrap.classList.contains('active')) {
      refreshHistoryTooltip()
    }
    // Invalidate balance cache after bridge status change so next hover/open gets fresh data
    const detail = (evt as CustomEvent).detail
    if (detail?.status === 'completed' || detail?.status === 'claim-ready') {
      balancesFetchedAt = 0
      setTimeout(() => void refreshBalances(true), 2_000)
    }
  })
  document.addEventListener('click', () => {
    historyWrap.classList.remove('active')
    historyBtn.setAttribute('aria-expanded', 'false')
  })

  updateHistoryButton()

  return {
    connectWrap,
    historyWrap,
    updateWalletButton,
    updateHistoryButton,
    showLoading,
    hideLoading,
    get userDisconnected() { return userDisconnected },
    set userDisconnected(v: boolean) { userDisconnected = v },
  }
}
