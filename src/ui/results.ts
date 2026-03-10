import type { Route } from '../core/types'
import { compareForCheapestSort } from '../core/quote'
import { formatUSDFee, formatTime, formatToken } from '../utils/format'
import { iconFastForward, iconCoin, iconCrown, iconArrowRightLong, iconRefresh, iconInfo, iconWarnPixel } from './icons'
import { PROVIDER_ICONS } from './provider-icons'
import { STABLECOINS } from '../config/tokens'
import { displayTokenSymbol } from '../config/chains'
import { appendTrustedSvg, clearChildren, setTrustedSvg } from '../utils/dom'

let allRoutesExpanded = false
let miniRouteSort: 'cheapest' | 'fastest' = 'cheapest'
let floatingMiniFeeTooltip: HTMLElement | null = null

function setNarrowAllRoutesScroll(enabled: boolean): void {
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches
  const active = narrow && enabled
  document.documentElement.classList.toggle('mobile-all-routes-open', active)
  document.body.classList.toggle('mobile-all-routes-open', active)
  const app = document.getElementById('app')
  if (app) app.classList.toggle('mobile-all-routes-open', active)
}

function closeMiniFeeTooltip(): void {
  if (floatingMiniFeeTooltip) {
    floatingMiniFeeTooltip.remove()
    floatingMiniFeeTooltip = null
  }
}

function openMiniFeeTooltip(anchor: HTMLElement, route: Route): void {
  closeMiniFeeTooltip()

  const tip = buildFeeTooltipEl(route)
  tip.classList.add('mini-fee-floating')
  tip.style.position = 'fixed'
  tip.style.left = '0px'
  tip.style.top = '0px'
  tip.style.bottom = 'auto'
  tip.style.transform = 'none'
  tip.style.opacity = '1'
  tip.style.pointerEvents = 'none'
  document.body.appendChild(tip)

  const anchorRect = anchor.getBoundingClientRect()
  const tipRect = tip.getBoundingClientRect()
  const EDGE_MARGIN = 8
  const OFFSET = 8

  let left = anchorRect.left + (anchorRect.width / 2) - (tipRect.width / 2)
  left = Math.max(EDGE_MARGIN, Math.min(left, window.innerWidth - tipRect.width - EDGE_MARGIN))

  let top = anchorRect.top - tipRect.height - OFFSET
  if (top < EDGE_MARGIN) {
    top = anchorRect.bottom + OFFSET
  }

  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
  floatingMiniFeeTooltip = tip
}

function isStablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase())
}

function displayReceiveSymbol(route: Route, tokenSymbol: string): string {
  // Use the route step's toToken if it differs (providers set this for cross-token bridges like USDT↔USDT0)
  const lastStep = route.steps[route.steps.length - 1]
  if (lastStep?.toToken && lastStep.toToken !== lastStep.fromToken) return lastStep.toToken
  if (tokenSymbol.toUpperCase() !== 'USDT') return tokenSymbol
  if (!lastStep) return tokenSymbol
  return displayTokenSymbol('USDT', lastStep.toChain)
}

export function renderRouteCards(
  container: HTMLElement,
  fastest: Route | null,
  cheapest: Route | null,
  allRoutes: Route[],
  tokenSymbol: string,
  tokenDecimals: number,
  tokenIcon: string | undefined,
  onBridge: (route: Route) => void,
  onRefresh?: () => void,
  inputUSD?: number,
): void {
  // Clearing/loading state is managed by the caller via container.dataset
  delete container.dataset.loading
  clearChildren(container)
  closeMiniFeeTooltip()
  setNarrowAllRoutesScroll(false)

  if (!fastest && !cheapest) {
    renderNoRouteState(container, onRefresh)
    return
  }

  const isSame = fastest && cheapest &&
    fastest.provider === cheapest.provider &&
    fastest.totalCostUSD === cheapest.totalCostUSD

  // Collect all actionable buttons to disable/enable on TTL
  const bridgeButtons: HTMLButtonElement[] = []
  const miniCardButtons: HTMLButtonElement[] = []

  // Determine the earliest expiry across all displayed routes
  const routes: Route[] = []
  if (isSame && fastest) {
    routes.push(fastest)
  } else {
    if (fastest) routes.push(fastest)
    if (cheapest) routes.push(cheapest)
  }
  const ttlSource = allRoutes.length ? allRoutes : routes
  const earliestExpiry = Math.min(...ttlSource.map(r => r.quoteExpiresAt))

  const ttlRow = document.createElement('div')
  ttlRow.className = 'ttl-row'

  const ttl = document.createElement('span')
  ttl.className = 'ttl-text'

  // TTL text parts (avoid interpolating dynamic values into innerHTML)
  const ttlPrefix = document.createElement('span')
  ttlPrefix.className = 'ttl-prefix'
  ttlPrefix.textContent = '[quote valid for '
  const ttlRemaining = document.createElement('span')
  ttlRemaining.className = 'ttl-remaining'
  const ttlSuffix = document.createElement('span')
  ttlSuffix.className = 'ttl-suffix'
  ttlSuffix.textContent = ']'

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'refresh-btn'
  setTrustedSvg(refreshBtn, iconRefresh(14))
  refreshBtn.title = 'Refresh quote'
  refreshBtn.setAttribute('aria-label', 'Refresh quote')
  refreshBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    onRefresh?.()
  })

  ttlRow.append(ttl, refreshBtn)

  const row = document.createElement('div')
  row.className = 'routes'

  const cardsRow = document.createElement('div')
  cardsRow.className = 'routes-cards'
  row.append(ttlRow, cardsRow)
  container.appendChild(row)

  const primaryRoutes: Array<{ route: Route; kind: 'fastest' | 'cheapest' | 'best' }> = []
  if (isSame && fastest) {
    primaryRoutes.push({ route: fastest, kind: 'best' })
  } else {
    if (fastest) primaryRoutes.push({ route: fastest, kind: 'fastest' })
    if (cheapest) primaryRoutes.push({ route: cheapest, kind: 'cheapest' })
  }

  if (primaryRoutes.length === 2) {
    cardsRow.classList.add('two-primary')
  }

  cardsRow.style.setProperty('--primary-count', String(primaryRoutes.length || 1))

  const primaryIdentitySet = new Set(primaryRoutes.map(p => routeIdentity(p.route)))
  const miniRoutes = allRoutes.length
    ? allRoutes.filter(r => !primaryIdentitySet.has(routeIdentity(r)))
    : []
  const primaryCols: HTMLElement[] = []

  for (const primary of primaryRoutes) {
    const { card, btn } = buildCard(
      primary.route,
      primary.kind,
      tokenSymbol,
      tokenDecimals,
      tokenIcon,
      onBridge,
      inputUSD,
    )
    const col = document.createElement('div')
    col.className = 'route-main-col'
    col.appendChild(card)
    primaryCols.push(col)
    bridgeButtons.push(btn)
    cardsRow.appendChild(col)
  }

  const { col: miniCol, buttons: miniButtons, refreshChevron } = buildMiniColumn(
    miniRoutes,
    tokenSymbol,
    tokenDecimals,
    tokenIcon,
    onBridge,
  )
  miniCardButtons.push(...miniButtons)
  cardsRow.appendChild(miniCol)

  const viewAllBtn = document.createElement('button')
  viewAllBtn.type = 'button'
  viewAllBtn.className = 'view-all-btn'
  if (miniRoutes.length === 0) {
    viewAllBtn.textContent = '[no additional routes]'
    viewAllBtn.disabled = true
  } else {
    viewAllBtn.textContent = '[all routes]'
    viewAllBtn.title = 'View all providers for this route'
    viewAllBtn.addEventListener('click', () => {
      const expanded = row.classList.toggle('routes-expanded')
      allRoutesExpanded = expanded
      setNarrowAllRoutesScroll(expanded && miniRoutes.length > 0)
      viewAllBtn.classList.toggle('active', expanded)
      viewAllBtn.textContent = expanded ? '[hide all routes]' : '[all routes]'
      requestAnimationFrame(refreshChevron)
    })
    if (allRoutesExpanded) {
      row.classList.add('routes-expanded')
      setNarrowAllRoutesScroll(true)
      viewAllBtn.classList.add('active')
      viewAllBtn.textContent = '[hide all routes]'
    } else {
      setNarrowAllRoutesScroll(false)
    }
  }
  row.appendChild(viewAllBtn)

  function syncMiniColumnHeight() {
    let maxHeight = 0
    for (const col of primaryCols) {
      maxHeight = Math.max(maxHeight, col.offsetHeight)
    }
    if (maxHeight > 0) {
      miniCol.style.height = `${maxHeight}px`
      refreshChevron()
    }
  }

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(syncMiniColumnHeight)
    for (const col of primaryCols) {
      ro.observe(col)
    }
  }

  const TTL_WARNING_THRESHOLD = 30 // seconds — 50% of 60s TTL (yellow)
  const TTL_DANGER_THRESHOLD = 5   // seconds — almost expired (red, but still usable)
  function updateTTL() {
    if (container.dataset.loading === 'true') {
      ttl.textContent = 'fetching quote…'
      ttl.classList.remove('ttl-expired', 'ttl-warning', 'ttl-danger')
      ttlRow.classList.add('ttl-loading')
      bridgeButtons.forEach(b => b.disabled = true)
      miniCardButtons.forEach(b => b.disabled = true)
      return
    }
    ttlRow.classList.remove('ttl-loading')

    const remaining = Math.max(0, Math.round((earliestExpiry - Date.now()) / 1000))
    if (remaining > 0) {
      ttlRemaining.textContent = `${remaining}s`
      if (ttl.firstChild !== ttlPrefix) {
        ttl.textContent = ''
        ttl.append(ttlPrefix, ttlRemaining, ttlSuffix)
      }
      ttl.classList.remove('ttl-expired')
      if (remaining <= TTL_DANGER_THRESHOLD) {
        ttl.classList.add('ttl-danger')
        ttl.classList.remove('ttl-warning')
      } else if (remaining <= TTL_WARNING_THRESHOLD) {
        ttl.classList.add('ttl-warning')
        ttl.classList.remove('ttl-danger')
      } else {
        ttl.classList.remove('ttl-warning', 'ttl-danger')
      }
      bridgeButtons.forEach(b => b.disabled = false)
      miniCardButtons.forEach(b => b.disabled = false)
    } else {
      ttl.textContent = '[quote expired]'
      ttl.classList.add('ttl-expired')
      ttl.classList.remove('ttl-warning', 'ttl-danger')
      bridgeButtons.forEach(b => b.disabled = true)
      miniCardButtons.forEach(b => b.disabled = true)
    }
  }
  updateTTL()
  const interval = setInterval(updateTTL, 1000)

  // Clean up when container is emptied
  const observer = new MutationObserver(() => {
    if (!ttlRow.isConnected) {
      clearInterval(interval)
      observer.disconnect()
    }
  })
  observer.observe(container.parentElement ?? document.body, { childList: true, subtree: true })

  requestAnimationFrame(() => {
    syncMiniColumnHeight()
    refreshChevron()
    if (container.parentElement) {
      observer.disconnect()
      observer.observe(container.parentElement, { childList: true, subtree: true })
    }
  })
}

function routeIdentity(route: Route): string {
  const step = route.steps[0]
  return [
    route.provider,
    step?.fromChain ?? 'na',
    step?.toChain ?? 'na',
    step?.amountIn ?? route.amountReceived,
    route.amountReceived,
  ].join('|')
}

function buildMiniColumn(
  routes: Route[],
  tokenSymbol: string,
  tokenDecimals: number,
  tokenIcon: string | undefined,
  onBridge: (route: Route) => void,
): { col: HTMLElement; buttons: HTMLButtonElement[]; refreshChevron: () => void } {
  const miniCol = document.createElement('div')
  miniCol.className = 'route-mini-col'

  const sortRow = document.createElement('div')
  sortRow.className = 'route-mini-sort'

  const sortCheapBtn = document.createElement('button')
  sortCheapBtn.type = 'button'
  sortCheapBtn.className = 'route-mini-sort-btn'
  sortCheapBtn.title = 'Sort by cheapest output'
  setTrustedSvg(sortCheapBtn, iconCoin(12))

  const sortFastBtn = document.createElement('button')
  sortFastBtn.type = 'button'
  sortFastBtn.className = 'route-mini-sort-btn'
  sortFastBtn.title = 'Sort by fastest route'
  setTrustedSvg(sortFastBtn, iconFastForward(12))

  function updateSortButtons() {
    sortCheapBtn.classList.toggle('active', miniRouteSort === 'cheapest')
    sortFastBtn.classList.toggle('active', miniRouteSort === 'fastest')
  }

  updateSortButtons()

  const miniScroll = document.createElement('div')
  miniScroll.className = 'route-mini-scroll'

  const miniChevron = document.createElement('div')
  miniChevron.className = 'route-mini-chevron'
  miniChevron.setAttribute('aria-hidden', 'true')

  const buttons: HTMLButtonElement[] = []

  function getSortedRoutes(): Route[] {
    const sorted = [...routes]
    if (miniRouteSort === 'fastest') {
      sorted.sort((a, b) => a.estimatedTime - b.estimatedTime)
    } else {
      sorted.sort(compareForCheapestSort)
    }
    return sorted
  }

  function renderMiniItems() {
    clearChildren(miniScroll)
    buttons.length = 0

    if (routes.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'route-mini-empty'
      empty.textContent = 'no additional routes'
      miniScroll.appendChild(empty)
      return
    }

    for (const route of getSortedRoutes()) {
      const mini = buildMiniCard(route, tokenSymbol, tokenDecimals, tokenIcon, onBridge)
      buttons.push(mini)
      miniScroll.appendChild(mini)
    }

    updateMiniChevronVisibility()
  }

  renderMiniItems()

  sortCheapBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    miniRouteSort = 'cheapest'
    updateSortButtons()
    renderMiniItems()
  })

  sortFastBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    miniRouteSort = 'fastest'
    updateSortButtons()
    renderMiniItems()
  })

  sortRow.append(sortFastBtn, sortCheapBtn)

  function updateMiniChevronVisibility() {
    const canScroll = miniScroll.scrollHeight > miniScroll.clientHeight + 1
    const atEnd = miniScroll.scrollTop + miniScroll.clientHeight >= miniScroll.scrollHeight - 1
    miniChevron.classList.toggle('visible', canScroll && !atEnd)
  }

  miniScroll.addEventListener('scroll', updateMiniChevronVisibility)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(updateMiniChevronVisibility)
    ro.observe(miniCol)
    ro.observe(miniScroll)
  }
  requestAnimationFrame(() => {
    updateMiniChevronVisibility()
  })

  miniCol.append(sortRow, miniScroll, miniChevron)
  return { col: miniCol, buttons, refreshChevron: updateMiniChevronVisibility }
}

function buildMiniCard(
  route: Route,
  tokenSymbol: string,
  tokenDecimals: number,
  tokenIcon: string | undefined,
  onBridge: (route: Route) => void,
): HTMLButtonElement {
  const mini = document.createElement('button')
  mini.type = 'button'
  mini.className = 'route-mini-card'
  mini.title = `Select ${route.provider}`
  mini.setAttribute('aria-label', `Select route via ${route.provider}`)
  mini.addEventListener('click', () => onBridge(route))

  const provider = document.createElement('div')
  provider.className = 'route-mini-provider'

  const nameWrap = document.createElement('span')
  nameWrap.className = 'route-mini-provider-name-wrap'

  const providerIconUrl = PROVIDER_ICONS[route.provider]
  if (providerIconUrl) {
    const icon = document.createElement('img')
    icon.src = providerIconUrl
    icon.alt = route.provider
    icon.width = 12
    icon.height = 12
    icon.className = 'route-mini-provider-icon'
    icon.onerror = () => { icon.style.display = 'none' }
    nameWrap.appendChild(icon)
  }

  const providerText = document.createElement('span')
  providerText.className = 'route-mini-provider-text'
  const timeStr = formatTime(route.estimatedTime)
  providerText.textContent = `${route.provider} (`
  const timeSpan = document.createElement('span')
  timeSpan.textContent = timeStr
  if (route.estimatedTime > 1800) timeSpan.className = 'route-time-slow'
  providerText.appendChild(timeSpan)
  providerText.append(')')
  nameWrap.appendChild(providerText)

  provider.append(nameWrap)

  const fee = document.createElement('div')
  fee.className = 'route-mini-stat route-mini-fee'

  const feeText = document.createElement('span')
  feeText.textContent = `cost ${formatUSDFee(route.totalCostUSD)}`

  const infoBtn = document.createElement('span')
  infoBtn.className = 'fee-info route-mini-fee-info'
  setTrustedSvg(infoBtn, iconInfo(11))
  infoBtn.addEventListener('mouseenter', () => {
    if (!infoBtn.classList.contains('active')) {
      openMiniFeeTooltip(infoBtn, route)
    }
  })
  infoBtn.addEventListener('mouseleave', () => {
    if (!infoBtn.classList.contains('active')) {
      closeMiniFeeTooltip()
    }
  })
  infoBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()

    const shouldOpen = !infoBtn.classList.contains('active')
    infoBtn.classList.toggle('active', shouldOpen)
    if (shouldOpen) {
      openMiniFeeTooltip(infoBtn, route)
    } else {
      closeMiniFeeTooltip()
    }
  })

  fee.append(feeText, infoBtn)

  const receiveSymbol = displayReceiveSymbol(route, tokenSymbol)
  const displayDecimals = isStablecoin(tokenSymbol) ? 3 : 5
  const receiveAmount = formatToken(route.amountReceived, tokenDecimals, displayDecimals)

  const receive = document.createElement('div')
  receive.className = 'route-mini-stat route-mini-receive'
  const receiveText = document.createElement('span')
  receiveText.textContent = `receive ${receiveAmount}`

  const receiveTokenWrap = document.createElement('span')
  receiveTokenWrap.className = 'route-mini-token-wrap'
  if (tokenIcon) {
    const icon = document.createElement('img')
    icon.src = tokenIcon
    icon.alt = receiveSymbol
    icon.width = 12
    icon.height = 12
    icon.className = 'route-mini-token-icon'
    icon.onerror = () => { icon.style.display = 'none' }
    receiveTokenWrap.appendChild(icon)
  }
  const tokenText = document.createElement('span')
  tokenText.textContent = receiveSymbol
  receiveTokenWrap.appendChild(tokenText)

  receive.append(receiveText, receiveTokenWrap)

  mini.append(provider, fee, receive)
  return mini
}

function buildCard(
  route: Route,
  kind: 'fastest' | 'cheapest' | 'best',
  tokenSymbol: string,
  tokenDecimals: number,
  tokenIcon: string | undefined,
  onBridge: (route: Route) => void,
  inputUSD?: number,
): { card: HTMLElement; btn: HTMLButtonElement } {
  const card = document.createElement('div')
  card.className = `route-card${kind === 'best' ? ' combined-card' : ''}`

  const LABEL_ICON_SIZE = 12
  const labelIcons: Record<string, string> = {
    fastest: iconFastForward(LABEL_ICON_SIZE),
    cheapest: iconCoin(LABEL_ICON_SIZE),
    best: iconCrown(16),
  }
  const labelTexts: Record<string, string> = {
    fastest: 'Fastest',
    cheapest: 'Cheapest',
    best: 'Best Route',
  }

  const label = document.createElement('div')
  label.className = `label ${kind}`
  appendTrustedSvg(label, labelIcons[kind])
  const labelText = document.createElement('span')
  labelText.className = 'label-text'
  labelText.textContent = labelTexts[kind]
  label.append(labelText)

  const provider = document.createElement('div')
  provider.className = 'provider'

  const providerInner = document.createElement('span')
  providerInner.className = 'provider-inner'

  const via = document.createElement('span')
  via.className = 'provider-via'
  via.textContent = 'via'

  const nameWrap = document.createElement('span')
  nameWrap.className = 'provider-name-wrap'

  const providerIconUrl = PROVIDER_ICONS[route.provider]
  if (providerIconUrl) {
    const PROVIDER_ICON_SIZE = 14
    const pIcon = document.createElement('img')
    pIcon.src = providerIconUrl
    pIcon.alt = route.provider
    pIcon.width = PROVIDER_ICON_SIZE
    pIcon.height = PROVIDER_ICON_SIZE
    pIcon.className = 'provider-icon'
    pIcon.onerror = () => { pIcon.style.display = 'none' }
    nameWrap.appendChild(pIcon)
  }

  const providerText = document.createElement('span')
  const timeStr = formatTime(route.estimatedTime)
  providerText.textContent = `${route.provider} (`
  const timeSpan = document.createElement('span')
  timeSpan.textContent = timeStr
  if (route.estimatedTime > 1800) timeSpan.className = 'route-time-slow'
  providerText.appendChild(timeSpan)
  providerText.append(')')
  nameWrap.appendChild(providerText)

  providerInner.append(via, nameWrap)
  provider.appendChild(providerInner)

  // Detect overflow after render and enable marquee
  requestAnimationFrame(() => {
    if (providerInner.scrollWidth > provider.clientWidth) {
      provider.classList.add('overflows')
      const distance = providerInner.scrollWidth - provider.clientWidth
      providerInner.style.setProperty('--scroll-distance', `-${distance}px`)
    }
  })
  const fee = document.createElement('div')
  fee.className = 'stat fee-stat'

  const feeText = document.createElement('span')
  feeText.textContent = `cost: ${formatUSDFee(route.totalCostUSD)}`
  fee.appendChild(feeText)

  // Build rich fee breakdown tooltip (DOM-based for better formatting)
  const infoBtn = document.createElement('span')
  infoBtn.className = 'fee-info'
  setTrustedSvg(infoBtn, iconInfo(12))
  const tooltip = buildFeeTooltipEl(route)
  infoBtn.appendChild(tooltip)
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    infoBtn.classList.toggle('active')
  })
  fee.appendChild(infoBtn)

  const receive = document.createElement('div')
  receive.className = 'stat receive-stat'
  const STABLE_DISPLAY_DECIMALS = 3
  const TOKEN_DISPLAY_DECIMALS = 5
  const displayDecimals = isStablecoin(tokenSymbol) ? STABLE_DISPLAY_DECIMALS : TOKEN_DISPLAY_DECIMALS
  const amountStr = formatToken(route.amountReceived, tokenDecimals, displayDecimals)

  // Check for significant value loss (>5%).
  const BAD_QUOTE_THRESHOLD = 0.95
  let lossPercent: string | null = null
  if (inputUSD && route.amountReceivedUSD < inputUSD * BAD_QUOTE_THRESHOLD) {
    lossPercent = ((1 - route.amountReceivedUSD / inputUSD) * 100).toFixed(0)
    route._uiLossPercent = lossPercent
  }

  const leftText = document.createElement('span')
  leftText.textContent = `receive: ${amountStr}`
  if (lossPercent) leftText.classList.add('receive-value-bad')
  receive.appendChild(leftText)

  const rightText = document.createElement('span')
  const receiveSymbol = displayReceiveSymbol(route, tokenSymbol)
  rightText.textContent = receiveSymbol
  if (lossPercent) rightText.classList.add('receive-value-bad')

  if (tokenIcon) {
    const tokenWrap = document.createElement('span')
    tokenWrap.className = 'receive-token-wrap'

    const TOKEN_ICON_SIZE = 16
    const icon = document.createElement('img')
    icon.src = tokenIcon
    icon.alt = receiveSymbol
    icon.className = 'receive-icon'
    icon.width = TOKEN_ICON_SIZE
    icon.height = TOKEN_ICON_SIZE

    tokenWrap.append(icon, rightText)
    receive.appendChild(tokenWrap)
  } else {
    receive.appendChild(rightText)
  }

  const btn = document.createElement('button')
  btn.className = 'bridge-btn route-bridge-btn'
  btn.type = 'button'
  const isSlow = route.estimatedTime > 1800
  if (lossPercent) {
    btn.classList.add('route-bridge-btn-bad')
    const warnIcon = document.createElement('span')
    warnIcon.className = 'route-bridge-btn-warn-icon'
    setTrustedSvg(warnIcon, iconWarnPixel(14))

    const warnText = document.createElement('span')
    warnText.className = 'route-bridge-btn-warn-text'
    warnText.textContent = `${lossPercent}% less`

    btn.append(warnIcon, warnText)
  } else if (isSlow) {
    btn.classList.add('route-bridge-btn-bad')
    const warnIcon = document.createElement('span')
    warnIcon.className = 'route-bridge-btn-warn-icon'
    setTrustedSvg(warnIcon, iconWarnPixel(14))

    const warnText = document.createElement('span')
    warnText.className = 'route-bridge-btn-warn-text'
    warnText.textContent = formatTime(route.estimatedTime)

    btn.append(warnIcon, warnText)
  } else {
    const BRIDGE_ARROW_WIDTH = 40
    const BRIDGE_ARROW_HEIGHT = 16
    setTrustedSvg(btn, iconArrowRightLong(BRIDGE_ARROW_WIDTH, BRIDGE_ARROW_HEIGHT))
  }
  btn.setAttribute('aria-label', `Bridge via ${route.provider}`)
  btn.title = 'bridge'
  btn.addEventListener('click', () => onBridge(route))

  card.append(label, provider, fee, receive, btn)
  return { card, btn }
}

function buildFeeTooltipEl(route: Route): HTMLElement {
  const tip = document.createElement('div')
  tip.className = 'fee-tooltip'

  function addRow(label: string, value: string, accent = false, centered = false) {
    const row = document.createElement('div')
    row.className = `fee-tooltip-row${centered ? ' fee-tooltip-centered' : ''}`
    if (label) {
      const lbl = document.createElement('span')
      lbl.className = 'fee-tooltip-label'
      lbl.textContent = label
      row.appendChild(lbl)
    }
    const val = document.createElement('span')
    val.className = `fee-tooltip-value${accent ? ' fee-tooltip-accent' : ''}`
    val.textContent = value
    row.appendChild(val)
    tip.appendChild(row)
  }

  if (route.steps.length <= 1) {
    const step = route.steps[0]
    if (!step) {
      addRow('', formatUSDFee(route.totalCostUSD), true, true)
      return tip
    }
    if (step.gasCostUSD > 0) addRow('gas', formatUSDFee(step.gasCostUSD))
    if (step.nativeFeeUSD && step.nativeFeeUSD > 0) addRow('messaging', formatUSDFee(step.nativeFeeUSD))
    if (step.feeUSD > 0) {
      const isBundle = step.gasCostUSD === 0 && (step.provider === 'Across' || step.provider === 'Relay')
      addRow(isBundle ? 'fees (incl. gas)' : 'provider', formatUSDFee(step.feeUSD))
    }
    addRow('protocol', '$0.00')
    const divider = document.createElement('div')
    divider.className = 'fee-tooltip-divider'
    tip.appendChild(divider)
    addRow('total:', formatUSDFee(route.totalCostUSD), true, true)
  } else {
    for (const step of route.steps) {
      const action = step.action === 'swap' ? 'Swap' : 'Bridge'
      const parts: string[] = []
      if (step.gasCostUSD > 0) parts.push(`gas ${formatUSDFee(step.gasCostUSD)}`)
      if (step.feeUSD > 0) parts.push(`fee ${formatUSDFee(step.feeUSD)}`)
      addRow(`${action} (${step.provider})`, parts.join(' + ') || 'free')
    }
    addRow('protocol', '$0.00')
    const divider = document.createElement('div')
    divider.className = 'fee-tooltip-divider'
    tip.appendChild(divider)
    addRow('total:', formatUSDFee(route.totalCostUSD), true, true)
  }

  return tip
}

export function renderSkeleton(container: HTMLElement): void {
  clearChildren(container)
  closeMiniFeeTooltip()
  setNarrowAllRoutesScroll(allRoutesExpanded)
  const row = document.createElement('div')
  row.className = 'routes'

  // Placeholder TTL row — matches the real TTL row height so cards don't jump
  const ttlPlaceholder = document.createElement('div')
  ttlPlaceholder.className = 'ttl-row'
  ttlPlaceholder.classList.add('ttl-loading')

  // Include the refresh button placeholder so the row height matches the real TTL row.
  const ttlText = document.createElement('span')
  ttlText.className = 'ttl-text'
  ttlText.textContent = 'fetching quote…'
  const refresh = document.createElement('button')
  refresh.className = 'refresh-btn'
  refresh.type = 'button'
  refresh.disabled = true
  refresh.setAttribute('aria-hidden', 'true')
  refresh.tabIndex = -1
  setTrustedSvg(refresh, iconRefresh(14))
  ttlPlaceholder.append(ttlText, refresh)
  row.appendChild(ttlPlaceholder)

  const cardsRow = document.createElement('div')
  cardsRow.className = 'routes-cards'
  cardsRow.classList.add('two-primary')
  row.appendChild(cardsRow)

  const SKELETON_CARD_COUNT = 2
  let firstMainCol: HTMLElement | null = null
  for (let i = 0; i < SKELETON_CARD_COUNT; i++) {
    const col = document.createElement('div')
    col.className = 'route-main-col'

    const card = document.createElement('div')
    card.className = 'route-card skeleton-card'
    // Matches real card structure: label, provider, fee, receive, button
    const mk = (cls: string) => {
      const d = document.createElement('div')
      d.className = `skeleton-line ${cls}`
      return d
    }
    card.append(
      mk('skeleton-label'),
      mk('skeleton-provider'),
      mk('skeleton-stat'),
      mk('skeleton-stat'),
      mk('skeleton-btn'),
    )
    col.appendChild(card)
    if (!firstMainCol) firstMainCol = col
    cardsRow.appendChild(col)
  }

  if (allRoutesExpanded) {
    row.classList.add('routes-expanded')
    const miniCol = document.createElement('div')
    miniCol.className = 'route-mini-col skeleton-mini-col'

    const sortRow = document.createElement('div')
    sortRow.className = 'route-mini-sort'
    const cheap = document.createElement('button')
    cheap.className = 'route-mini-sort-btn active'
    cheap.type = 'button'
    cheap.disabled = true
    setTrustedSvg(cheap, iconCoin(12))
    const fast = document.createElement('button')
    fast.className = 'route-mini-sort-btn'
    fast.type = 'button'
    fast.disabled = true
    setTrustedSvg(fast, iconFastForward(12))
    sortRow.append(fast, cheap)

    const miniScroll = document.createElement('div')
    miniScroll.className = 'route-mini-scroll skeleton-mini-scroll'

    const MINI_SKELETON_COUNT = 3
    for (let i = 0; i < MINI_SKELETON_COUNT; i++) {
      const miniCard = document.createElement('div')
      miniCard.className = 'route-mini-card skeleton-mini-card'

      const providerRow = document.createElement('div')
      providerRow.className = 'route-mini-provider'
      const providerIcon = document.createElement('div')
      providerIcon.className = 'skeleton-line skeleton-mini-icon'
      const providerText = document.createElement('div')
      providerText.className = 'skeleton-line skeleton-mini-provider'
      providerRow.append(providerIcon, providerText)

      const feeRow = document.createElement('div')
      feeRow.className = 'route-mini-stat route-mini-fee'
      const feeText = document.createElement('div')
      feeText.className = 'skeleton-line skeleton-mini-fee-text'
      const feeIcon = document.createElement('div')
      feeIcon.className = 'skeleton-line skeleton-mini-fee-icon'
      feeRow.append(feeText, feeIcon)

      const receiveRow = document.createElement('div')
      receiveRow.className = 'route-mini-stat'
      const receiveText = document.createElement('div')
      receiveText.className = 'skeleton-line skeleton-mini-receive-text'
      const receiveToken = document.createElement('div')
      receiveToken.className = 'skeleton-line skeleton-mini-token'
      receiveRow.append(receiveText, receiveToken)

      miniCard.append(providerRow, feeRow, receiveRow)
      miniScroll.appendChild(miniCard)
    }

    const chevron = document.createElement('div')
    chevron.className = 'route-mini-chevron visible'
    chevron.setAttribute('aria-hidden', 'true')

    miniCol.append(sortRow, miniScroll, chevron)
    cardsRow.appendChild(miniCol)

    requestAnimationFrame(() => {
      if (firstMainCol) {
        miniCol.style.height = `${firstMainCol.offsetHeight}px`
      }
    })
  }

  const viewAllBtn = document.createElement('button')
  viewAllBtn.className = 'view-all-btn'
  viewAllBtn.type = 'button'
  viewAllBtn.textContent = allRoutesExpanded ? '[hide all routes]' : '[all routes]'
  if (allRoutesExpanded) viewAllBtn.classList.add('active')
  viewAllBtn.addEventListener('click', () => {
    allRoutesExpanded = !allRoutesExpanded
    renderSkeleton(container)
  })
  row.appendChild(viewAllBtn)

  container.appendChild(row)
}

export function renderError(container: HTMLElement, message: string): void {
  clearChildren(container)
  setNarrowAllRoutesScroll(false)
  const err = document.createElement('div')
  err.className = 'error-msg'
  err.setAttribute('role', 'alert')
  err.textContent = message
  container.appendChild(err)
}

export function renderNoRouteState(container: HTMLElement, onRefresh?: () => void): void {
  clearChildren(container)
  setNarrowAllRoutesScroll(false)

  const empty = document.createElement('div')
  empty.className = 'error-msg route-empty-msg'
  empty.setAttribute('role', 'alert')

  const text = document.createElement('span')
  text.textContent = 'no route found. refresh or change amount'
  empty.appendChild(text)

  if (onRefresh) {
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'refresh-btn'
    setTrustedSvg(refreshBtn, iconRefresh(14))
    refreshBtn.title = 'Refresh quote'
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      onRefresh()
    })
    empty.appendChild(refreshBtn)
  }

  container.appendChild(empty)
}