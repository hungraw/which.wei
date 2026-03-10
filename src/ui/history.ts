import { chains, displayTokenSymbol } from '../config/chains'
import { STABLECOINS, tokens } from '../config/tokens'
import type { Chain } from '../core/types'
import { explorerTxUrl, formatToken } from '../utils/format'
import { iconArrowRightLong, iconCheck, iconClaim, iconCross, iconExternalLink, iconX } from './icons'
import { PROVIDER_ICONS } from './provider-icons'
import { z } from 'zod'
import { setTrustedSvg } from '../utils/dom'
import { getBridgeByTxHash } from '../tracking/store'
import type { TrackedBridge } from '../tracking/types'
import { showModal, closeModal } from './modal'
import { renderChainSummary, renderProviderRow } from './bridge-summary'

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/

const HistoryEntrySchema = z.object({
  txHash: z.string().regex(TX_HASH_RE),
  destinationTxHash: z.string().regex(TX_HASH_RE).optional(),
  fromChainId: z.number().int().finite(),
  toChainId: z.number().int().finite(),
  token: z.string().min(1).max(16),
  status: z.enum(['COMPLETED', 'IN-FLIGHT', 'FAILED']).optional(),
  amountIn: z.string().max(96),
  amountOut: z.string().max(96),
  provider: z.string().min(1).max(40),
  timestamp: z.number().int().finite(),
  explorerUrl: z.string().optional(),
  destinationExplorerUrl: z.string().optional(),
}).passthrough()

const HistorySchema = z.array(HistoryEntrySchema)

export interface HistoryEntry {
  txHash: string
  destinationTxHash?: string
  fromChainId: number
  toChainId: number
  token: string
  status?: 'COMPLETED' | 'IN-FLIGHT' | 'FAILED'
  amountIn: string
  amountOut: string
  provider: string
  timestamp: number
  explorerUrl?: string
  destinationExplorerUrl?: string
}

const STORAGE_KEY = 'whichwei:tx-history'
export const MAX_ENTRIES = 100

// Build chain lookup map (lazy to avoid test environment issues)
let chainByIdMap: Map<number, Chain> | null = null
function getChainById(id: number): Chain | undefined {
  if (!chainByIdMap) {
    chainByIdMap = new Map(chains?.map((c: Chain) => [c.id, c]) ?? [])
  }
  return chainByIdMap.get(id)
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const result = HistorySchema.safeParse(parsed)
    if (!result.success) return []
    return result.data as HistoryEntry[]
  } catch {
    return []
  }
}

export function saveTransaction(entry: HistoryEntry): void {
  try {
    const history = loadHistory()
    history.unshift(entry)
    if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {
    // localStorage may be full or blocked — silently ignore
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
  }
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}D AGO`
  if (hours > 0) return `${hours}H AGO`
  if (minutes > 0) return `${minutes}M AGO`
  return 'JUST NOW'
}

function resolveHistoryStatus(
  entry: HistoryEntry,
  trackedBridge: TrackedBridge | undefined,
): 'COMPLETED' | 'IN-FLIGHT' | 'FAILED' | 'CLAIM-READY' {
  if (trackedBridge) {
    if (trackedBridge.status === 'completed') return 'COMPLETED'
    if (trackedBridge.status === 'failed' || trackedBridge.status === 'unconfirmed') return 'FAILED'
    if (trackedBridge.status === 'claim-ready') return 'CLAIM-READY'
    return 'IN-FLIGHT'
  }
  return entry.status ?? 'COMPLETED'
}

function openHistoryStatusModal(
  entry: HistoryEntry,
  trackedBridge: TrackedBridge | undefined,
  status: 'COMPLETED' | 'IN-FLIGHT' | 'FAILED' | 'CLAIM-READY',
): void {
  const content = document.createElement('div')
  content.className = 'bridge-result-content'

  const statusIcon = document.createElement('div')
  statusIcon.className = `bridge-result-icon ${status === 'COMPLETED' ? 'success' : status === 'FAILED' ? 'fail' : ''}`
  if (status === 'COMPLETED') {
    setTrustedSvg(statusIcon, iconCheck(52))
  } else if (status === 'FAILED') {
    setTrustedSvg(statusIcon, iconCross(52))
  } else if (status === 'CLAIM-READY') {
    statusIcon.classList.add('claim')
    setTrustedSvg(statusIcon, iconClaim(52))
  } else {
    statusIcon.classList.remove('fail')
    const loader = document.createElement('span')
    loader.className = 'history-pending-loader modal-pending-loader'
    statusIcon.append(loader)
  }
  content.append(statusIcon)

  const fromChain = getChainById(entry.fromChainId)
  const toChain = getChainById(entry.toChainId)
  const fromTokenSymbol = displayTokenSymbol(entry.token, entry.fromChainId)
  const toTokenSymbol = displayTokenSymbol(entry.token, entry.toChainId)
  const decimals = STABLECOINS.has(entry.token.toUpperCase()) ? 6 : 18

  const isLZ = entry.provider === 'Stargate Taxi' || entry.provider === 'Stargate Bus' || entry.provider === 'USDT0'

  const summary = renderChainSummary({
    fromChain,
    toChain,
    sendAmount: entry.amountIn,
    receiveAmount: entry.amountOut,
    tokenSymbol: entry.token,
    sendTokenSymbol: fromTokenSymbol,
    receiveTokenSymbol: toTokenSymbol,
    srcDecimals: decimals,
    dstDecimals: decimals,
    displayDecimals: STABLECOINS.has(entry.token.toUpperCase()) ? 3 : 5,
    classPrefix: 'bridge-result',
    srcExplorerUrl: fromChain?.explorerUrl,
    srcTxHash: entry.txHash,
    dstExplorerUrl: isLZ ? 'https://layerzeroscan.com' : toChain?.explorerUrl,
    dstTxHash: isLZ ? entry.txHash : (trackedBridge?.fillTxHash ?? entry.destinationTxHash),
  })
  content.appendChild(summary)

  // Provider row
  content.appendChild(renderProviderRow(entry.provider, 'bridge-result', 18, undefined, true))

  // CCTP Slow claim button — below provider row
  if (status === 'CLAIM-READY' && trackedBridge?.cctpMessage && trackedBridge?.cctpAttestation) {
    const claimBtn = document.createElement('button')
    claimBtn.className = 'bridge-btn bridge-result-claim-btn'

    // Build "Claim [icon] USDC" with proper spacing
    const claimLabel = document.createTextNode('Claim')
    const claimSpacer = document.createElement('span')
    claimSpacer.style.width = '0.45em'
    claimSpacer.style.display = 'inline-block'

    // Use the token icon (e.g. USDC icon) from config
    const tokenDef = tokens.find(t => t.symbol.toUpperCase() === entry.token.toUpperCase())
    if (tokenDef?.icon) {
      const tokenImg = document.createElement('img')
      tokenImg.src = tokenDef.icon
      tokenImg.alt = entry.token
      tokenImg.className = 'claim-btn-token-icon'
      tokenImg.width = 16
      tokenImg.height = 16
      tokenImg.onerror = () => { tokenImg.style.display = 'none' }
      const tokenSpacer = document.createElement('span')
      tokenSpacer.style.width = '0.25em'
      tokenSpacer.style.display = 'inline-block'
      claimBtn.append(claimLabel, claimSpacer, tokenImg, tokenSpacer)
    } else {
      claimBtn.append(claimLabel, claimSpacer)
    }
    const tokenLabel = document.createTextNode(entry.token)
    claimBtn.append(tokenLabel)

    claimBtn.addEventListener('click', async () => {
      claimBtn.disabled = true
      claimBtn.textContent = 'Claiming...'
      try {
        const { claimCCTPSlow } = await import('../providers/cctp')
        const { updateBridge } = await import('../tracking/store')
        const result = await claimCCTPSlow(
          entry.toChainId,
          trackedBridge.cctpMessage!,
          trackedBridge.cctpAttestation!,
          (msg) => { claimBtn.textContent = msg },
        )
        if (result.success) {
          if (trackedBridge) {
            const chain = getChainById(entry.toChainId)
            updateBridge(trackedBridge.id, {
              status: 'completed',
              completedAt: Date.now(),
              fillTxHash: result.destinationTxHash,
              destExplorerUrl: chain && result.destinationTxHash
                ? explorerTxUrl(chain.explorerUrl, result.destinationTxHash) ?? undefined
                : undefined,
            })
          }
          closeModal()
        } else {
          claimBtn.textContent = 'Claim failed — retry'
          claimBtn.disabled = false
        }
      } catch {
        claimBtn.textContent = 'Claim failed — retry'
        claimBtn.disabled = false
      }
    })
    content.appendChild(claimBtn)
  }

  // Close button (skip for claim modal — claim button already acts as primary action)
  if (status !== 'CLAIM-READY') {
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
  }

  showModal({
    title: '',
    content,
    closable: true,
    modalClass: 'bridge-result-modal',
  })
}

export function renderHistoryList(): HTMLElement {
  const container = document.createElement('div')
  container.className = 'history-list'

  const history = loadHistory()

  if (history.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = 'No bridge history yet'
    container.appendChild(empty)
    return container
  }

  for (const entry of history) {
    const trackedBridge = getBridgeByTxHash(entry.txHash)
    const statusValue = resolveHistoryStatus(entry, trackedBridge)
    const destinationTxHash = trackedBridge?.fillTxHash ?? entry.destinationTxHash

    const card = document.createElement('div')
    card.className = 'history-entry'
    card.tabIndex = 0

    const fromChain = getChainById(entry.fromChainId)
    const toChain = getChainById(entry.toChainId)
    const fromTokenSymbol = displayTokenSymbol(entry.token, entry.fromChainId)
    const toTokenSymbol = displayTokenSymbol(entry.token, entry.toChainId)
    const decimals = STABLECOINS.has(entry.token.toUpperCase()) ? 6 : 18
    const inAmt = formatToken(entry.amountIn, decimals, 3)
    const outAmt = formatToken(entry.amountOut, decimals, 3)

    // Left: [fromSide] → [toSide]  where each side is icon on top, amount below
    const left = document.createElement('div')
    left.className = 'history-left'

    const status = document.createElement('div')
    status.className = 'history-status'
    if (statusValue === 'COMPLETED') {
      status.classList.add('history-status-completed')
      const icon = document.createElement('span')
      icon.className = 'history-status-icon'
      setTrustedSvg(icon, iconCheck(18))
      status.appendChild(icon)
    } else if (statusValue === 'FAILED') {
      status.classList.add('history-status-failed')
      const icon = document.createElement('span')
      icon.className = 'history-status-icon'
      setTrustedSvg(icon, iconCross(18))
      status.appendChild(icon)
    } else if (statusValue === 'CLAIM-READY') {
      status.classList.add('history-status-inflight')
      const claimSvgIcon = document.createElement('span')
      claimSvgIcon.className = 'history-status-icon history-status-claim'
      setTrustedSvg(claimSvgIcon, iconClaim(18))
      status.appendChild(claimSvgIcon)
    } else {
      status.classList.add('history-status-inflight')
      const loader = document.createElement('span')
      loader.className = 'history-pending-loader'
      status.append(loader)
    }

    const routeRow = document.createElement('div')
    routeRow.className = 'history-route-row'

    const fromSide = document.createElement('div')
    fromSide.className = 'history-side'
    if (fromChain?.icon) {
      const img = document.createElement('img')
      img.src = fromChain.icon
      img.alt = fromChain.name
      img.className = 'history-chain-icon'
      img.width = 18
      img.height = 18
      fromSide.appendChild(img)
    }
    const fromAmt = document.createElement('span')
    fromAmt.className = 'history-amt'
    fromAmt.textContent = `${inAmt} ${fromTokenSymbol}`
    fromSide.appendChild(fromAmt)

    const arrow = document.createElement('div')
    arrow.className = 'history-arrow'
    setTrustedSvg(arrow, iconArrowRightLong(20, 10))

    const toSide = document.createElement('div')
    toSide.className = 'history-side'
    if (toChain?.icon) {
      const img = document.createElement('img')
      img.src = toChain.icon
      img.alt = toChain.name
      img.className = 'history-chain-icon'
      img.width = 18
      img.height = 18
      toSide.appendChild(img)
    }
    const toAmt = document.createElement('span')
    toAmt.className = 'history-amt'
    toAmt.textContent = `${outAmt} ${toTokenSymbol}`
    toSide.appendChild(toAmt)

    routeRow.append(fromSide, arrow, toSide)

    // Separator between status and route
    const sep1 = document.createElement('div')
    sep1.className = 'history-sep'

    left.append(status, sep1, routeRow)

    // Right: [provider+explorer] on top, [time] below
    const right = document.createElement('div')
    right.className = 'history-right'

    const rightIcons = document.createElement('div')
    rightIcons.className = 'history-right-icons'

    const pIconUrl = PROVIDER_ICONS[entry.provider]
    if (pIconUrl) {
      const pImg = document.createElement('img')
      pImg.src = pIconUrl
      pImg.alt = entry.provider
      pImg.title = entry.provider
      pImg.className = 'history-provider-icon'
      pImg.width = 18
      pImg.height = 18
      rightIcons.appendChild(pImg)
    }

    const explorerHref = destinationTxHash && toChain?.explorerUrl
      ? explorerTxUrl(toChain.explorerUrl, destinationTxHash)
      : (fromChain?.explorerUrl ? explorerTxUrl(fromChain.explorerUrl, entry.txHash) : null)
    if (explorerHref) {
      const link = document.createElement('a')
      link.href = explorerHref
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.className = 'history-explorer-link'
      link.title = 'View on explorer'
      link.addEventListener('click', (e) => e.stopPropagation())
      setTrustedSvg(link, iconExternalLink(18))
      rightIcons.appendChild(link)
    }

    const time = document.createElement('span')
    time.className = 'history-time'
    time.textContent = formatRelativeTime(entry.timestamp)

    right.append(rightIcons, time)

    // Separator between route and right details
    const sep2 = document.createElement('div')
    sep2.className = 'history-sep'

    card.append(left, sep2, right)
    card.addEventListener('click', () => openHistoryStatusModal(entry, trackedBridge, statusValue))
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openHistoryStatusModal(entry, trackedBridge, statusValue)
      }
    })
    container.appendChild(card)
  }

  return container
}
