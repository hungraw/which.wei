import type { Chain } from '../core/types'
import { PROVIDER_ICONS } from './provider-icons'
import { iconArrowRightLong, iconExternalLink } from './icons'
import { formatToken, explorerTxUrl } from '../utils/format'
import { setTrustedSvg } from '../utils/dom'

const CHAIN_ICON_SIZE = 36

function buildChainSide(
  classPrefix: string,
  chain: { icon?: string; name: string } | undefined,
  amountText: string,
  explorerUrl: string | undefined,
  txHash: string | undefined,
  linkTitle: string,
): HTMLDivElement {
  const side = document.createElement('div')
  side.className = `${classPrefix}-side`
  if (chain?.icon) {
    const img = document.createElement('img')
    img.src = chain.icon
    img.alt = chain.name
    img.className = `${classPrefix}-chain-icon`
    img.width = CHAIN_ICON_SIZE
    img.height = CHAIN_ICON_SIZE
    side.appendChild(img)
  }
  const textDiv = document.createElement('div')
  textDiv.className = `${classPrefix}-side-text`
  const amt = document.createElement('div')
  amt.className = `${classPrefix}-amt`
  amt.textContent = amountText
  if (explorerUrl && txHash) {
    const url = explorerTxUrl(explorerUrl, txHash)
    if (url) {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.className = `${classPrefix}-amt-explorer`
      link.title = linkTitle
      setTrustedSvg(link, iconExternalLink(14))
      amt.appendChild(link)
    }
  }
  textDiv.append(amt)
  side.appendChild(textDiv)
  return side
}

export interface ChainSummaryOpts {
  fromChain: Chain | undefined
  toChain: Chain | undefined
  sendAmount: string
  receiveAmount: string
  tokenSymbol: string
  sendTokenSymbol?: string
  receiveTokenSymbol?: string
  srcDecimals: number
  dstDecimals: number
  displayDecimals: number
  classPrefix: string
  /** Optional: source chain explorer base URL + tx hash → shows external link icon next to send amount */
  srcExplorerUrl?: string
  srcTxHash?: string
  /** Optional: dest chain explorer base URL + tx hash → shows external link icon next to receive amount */
  dstExplorerUrl?: string
  dstTxHash?: string
}

export function renderChainSummary(opts: ChainSummaryOpts): HTMLElement {
  const {
    fromChain,
    toChain,
    sendAmount,
    receiveAmount,
    tokenSymbol,
    sendTokenSymbol,
    receiveTokenSymbol,
    srcDecimals,
    dstDecimals,
    displayDecimals,
    classPrefix,
    srcExplorerUrl,
    srcTxHash,
    dstExplorerUrl,
    dstTxHash,
  } = opts
  const fromSymbol = sendTokenSymbol ?? tokenSymbol
  const toSymbol = receiveTokenSymbol ?? tokenSymbol

  const summary = document.createElement('div')
  summary.className = `${classPrefix}-summary`

  const left = buildChainSide(classPrefix, fromChain, `${formatToken(sendAmount, srcDecimals, displayDecimals)} ${fromSymbol}`, srcExplorerUrl, srcTxHash, 'Source tx')

  const arrow = document.createElement('div')
  arrow.className = `${classPrefix}-arrow`
  setTrustedSvg(arrow, iconArrowRightLong(28, 12))

  const right = buildChainSide(classPrefix, toChain, `${formatToken(receiveAmount, dstDecimals, displayDecimals)} ${toSymbol}`, dstExplorerUrl, dstTxHash, 'Destination tx')

  summary.append(left, arrow, right)
  return summary
}

export function renderProviderRow(
  provider: string,
  classPrefix: string,
  iconSize: number,
  suffixText?: string,
  showVia = false,
): HTMLElement {
  const row = document.createElement('div')
  row.className = `${classPrefix}-provider`
  
  if (showVia) {
    const viaSpan = document.createElement('span')
    viaSpan.className = `${classPrefix}-provider-via`
    viaSpan.textContent = 'via '
    row.appendChild(viaSpan)
  }
  
  const pIconUrl = PROVIDER_ICONS[provider]
  if (pIconUrl) {
    const img = document.createElement('img')
    img.src = pIconUrl
    img.alt = provider
    img.width = iconSize
    img.height = iconSize
    img.className = `${classPrefix}-provider-icon`
    img.onerror = () => { img.style.display = 'none' }
    row.appendChild(img)
  }
  const pText = document.createElement('span')
  pText.textContent = suffixText ? `${provider} ${suffixText}` : provider
  row.appendChild(pText)
  return row
}
