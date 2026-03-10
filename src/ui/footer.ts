import type { Chain } from '../core/types'
import { PROVIDER_ICONS } from './provider-icons'
import { iconDot } from './icons'
import { setTrustedSvg } from '../utils/dom'
import {
  primeRpcProviderLatency,
  getGlobalRpcProvider,
  setGlobalRpcProvider,
  getCustomRpcUrl,
  setCustomRpcUrl,
  type RpcProvider,
} from '../utils/rpc'

import { createAnalyticsPanel, loadAnalyticsPanel } from './analytics'

const FOOTER_ICON_SIZE = 14

/** Raw inline SVG string of the WEI icon — use with setTrustedSvg for guaranteed rendering */
export const WEI_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" width=\"12\" height=\"12\"><rect width=\"16\" height=\"16\" fill=\"#222\"/><rect x=\"3\" y=\"1\" width=\"1\" height=\"1\" fill=\"#ccc\"/><rect x=\"5\" y=\"2\" width=\"1\" height=\"1\" fill=\"#ccc\"/><rect x=\"10\" y=\"2\" width=\"1\" height=\"1\" fill=\"#ccc\"/><rect x=\"12\" y=\"1\" width=\"1\" height=\"1\" fill=\"#ccc\"/><rect x=\"4\" y=\"4\" width=\"8\" height=\"1\" fill=\"#ccc\"/><rect x=\"3\" y=\"5\" width=\"10\" height=\"1\" fill=\"#ccc\"/><rect x=\"2\" y=\"6\" width=\"12\" height=\"3\" fill=\"#ccc\"/><rect x=\"3\" y=\"9\" width=\"10\" height=\"1\" fill=\"#ccc\"/><rect x=\"4\" y=\"10\" width=\"8\" height=\"1\" fill=\"#ccc\"/><rect x=\"3\" y=\"6\" width=\"3\" height=\"2\" fill=\"#222\"/><rect x=\"10\" y=\"6\" width=\"3\" height=\"2\" fill=\"#222\"/><rect x=\"5\" y=\"11\" width=\"2\" height=\"1\" fill=\"#ccc\"/><rect x=\"9\" y=\"11\" width=\"2\" height=\"1\" fill=\"#ccc\"/><rect x=\"2\" y=\"12\" width=\"3\" height=\"1\" fill=\"#ccc\"/><rect x=\"7\" y=\"12\" width=\"2\" height=\"1\" fill=\"#ccc\"/><rect x=\"11\" y=\"12\" width=\"3\" height=\"1\" fill=\"#ccc\"/><rect x=\"1\" y=\"13\" width=\"2\" height=\"1\" fill=\"#ccc\"/><rect x=\"13\" y=\"13\" width=\"2\" height=\"1\" fill=\"#ccc\"/></svg>"

export interface FooterConfig {
  chains: Chain[]
  getFromChainId: () => number
  onRpcChange: () => void
}

export function buildFooter(config: FooterConfig): HTMLElement {
  const { chains, getFromChainId, onRpcChange } = config

  const footer = document.createElement('footer')
  footer.className = 'footer'

  const footerProvidersWrap = document.createElement('div')
  footerProvidersWrap.className = 'footer-providers-wrap'

  const footerIcon = document.createElement('button')
  footerIcon.type = 'button'
  footerIcon.className = 'footer-providers-icon'
  footerIcon.setAttribute('aria-haspopup', 'true')
  footerIcon.setAttribute('aria-expanded', 'false')

  const tooltip = document.createElement('div')
  tooltip.className = 'footer-tooltip'

  const providers: Array<{ name: string; icon: string }> = [
    { name: 'CCTP', icon: PROVIDER_ICONS['CCTP'] },
    { name: 'USDT0', icon: PROVIDER_ICONS['USDT0'] },
    { name: 'Across', icon: PROVIDER_ICONS['Across'] },
    { name: 'Relay', icon: PROVIDER_ICONS['Relay'] },
    { name: 'deBridge', icon: PROVIDER_ICONS['deBridge'] },
    { name: 'Eco', icon: PROVIDER_ICONS['Eco'] },
    { name: 'Gas.zip', icon: PROVIDER_ICONS['Gas.zip'] },
    // Footer lists protocols (not individual routes/modes)
    { name: 'Stargate', icon: PROVIDER_ICONS['Stargate Taxi'] },
    { name: 'cBridge', icon: PROVIDER_ICONS['cBridge'] },
    { name: 'Synapse', icon: PROVIDER_ICONS['Synapse'] },
    { name: 'Orbiter', icon: PROVIDER_ICONS['Orbiter'] },
    { name: 'Mayan', icon: PROVIDER_ICONS['Mayan Swift'] },
  ]

  footerIcon.textContent = 'providers'

  const tooltipHeader = document.createElement('div')
  tooltipHeader.className = 'footer-tooltip-header'
  tooltipHeader.textContent = `aggregating ${providers.length} sources:`
  tooltip.appendChild(tooltipHeader)

  for (const p of providers) {
    const row = document.createElement('div')
    row.className = 'footer-tooltip-row'
    const img = document.createElement('img')
    img.src = p.icon
    img.alt = p.name
    img.width = FOOTER_ICON_SIZE
    img.height = FOOTER_ICON_SIZE
    img.className = 'footer-tooltip-logo'
    img.onerror = () => { img.style.display = 'none' }
    const name = document.createElement('span')
    name.textContent = p.name
    row.append(img, name)
    tooltip.appendChild(row)
  }

  footerProvidersWrap.append(footerIcon, tooltip)

  footerIcon.addEventListener('click', (e) => {
    e.stopPropagation()
    footerProvidersWrap.classList.toggle('active')
    footerIcon.setAttribute('aria-expanded', footerProvidersWrap.classList.contains('active') ? 'true' : 'false')
  })
  document.addEventListener('click', () => {
    footerProvidersWrap.classList.remove('active')
    footerIcon.setAttribute('aria-expanded', 'false')
  })

  const sep = document.createElement('span')
  sep.className = 'footer-sep'
  setTrustedSvg(sep, iconDot(8))

  const aboutWrap = document.createElement('div')
  aboutWrap.className = 'footer-about-wrap'

  const aboutBtn = document.createElement('button')
  aboutBtn.type = 'button'
  aboutBtn.className = 'footer-about-trigger'
  aboutBtn.textContent = 'about'
  aboutBtn.setAttribute('aria-haspopup', 'true')
  aboutBtn.setAttribute('aria-expanded', 'false')

  const aboutTip = document.createElement('div')
  aboutTip.className = 'about-tooltip'

  const ruleTexts = [
    '"mostly" decentralized bridge aggregator',
    '0% markup - provider fees only',
    'unaudited slop - use at your own risk',
  ]
  const ruleEls = ruleTexts.map(text => {
    const el = document.createElement('div')
    el.className = 'about-rule'
    el.appendChild(document.createTextNode(text))
    return el
  })
  const contact = document.createElement('div')
  contact.className = 'about-contact'
  const nftIcon = document.createElement('img')
  nftIcon.src = './nft.svg'
  nftIcon.alt = ''
  nftIcon.width = 18
  nftIcon.height = 18
  nftIcon.className = 'about-nft-icon'
  nftIcon.onerror = () => { nftIcon.style.display = 'none' }
  const handle = document.createElement('span')
  handle.className = 'about-handle'
  handle.textContent = '@rawxbt'
  contact.append(nftIcon, handle)

  aboutTip.append(...ruleEls, contact)

  // Analytics panel embedded in about tooltip
  const analyticsPanel = createAnalyticsPanel()
  // Insert between rules and contact
  aboutTip.insertBefore(analyticsPanel, contact)

  aboutWrap.append(aboutBtn, aboutTip)

  let analyticsLoaded = false
  aboutBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    aboutWrap.classList.toggle('active')
    aboutBtn.setAttribute('aria-expanded', aboutWrap.classList.contains('active') ? 'true' : 'false')
    // Load analytics when about opens (lazy, once per session or on TTL expiry)
    if (aboutWrap.classList.contains('active') && !analyticsLoaded) {
      analyticsLoaded = true
      void loadAnalyticsPanel(analyticsPanel)
    }
  })
  document.addEventListener('click', () => {
    aboutWrap.classList.remove('active')
    aboutBtn.setAttribute('aria-expanded', 'false')
  })

  const settingsSep = document.createElement('span')
  settingsSep.className = 'footer-sep'
  setTrustedSvg(settingsSep, iconDot(8))

  const settingsWrap = document.createElement('div')
  settingsWrap.className = 'footer-settings-wrap'

  const settingsBtn = document.createElement('button')
  settingsBtn.type = 'button'
  settingsBtn.className = 'footer-settings-trigger'
  settingsBtn.textContent = 'settings'
  settingsBtn.setAttribute('aria-haspopup', 'true')
  settingsBtn.setAttribute('aria-expanded', 'false')

  let hoverCloseTimer: number | null = null
  settingsWrap.addEventListener('mouseenter', () => {
    if (hoverCloseTimer !== null) window.clearTimeout(hoverCloseTimer)
    hoverCloseTimer = null
    settingsWrap.classList.add('hovering')
  })
  settingsWrap.addEventListener('mouseleave', () => {
    if (settingsWrap.classList.contains('active')) return
    if (hoverCloseTimer !== null) window.clearTimeout(hoverCloseTimer)
    hoverCloseTimer = window.setTimeout(() => {
      settingsWrap.classList.remove('hovering')
      hoverCloseTimer = null
    }, 250)
  })

  const settingsTip = document.createElement('div')
  settingsTip.className = 'settings-tooltip'
  settingsTip.addEventListener('click', (e) => e.stopPropagation())

  const rpcRow = document.createElement('div')
  rpcRow.className = 'settings-row'

  const rpcLabel = document.createElement('span')
  rpcLabel.className = 'settings-label'
  rpcLabel.textContent = 'rpc'

  const rpcOptions: Array<{ v: RpcProvider; label: string }> = [
    { v: 'default', label: 'publicnode (default)' },
    { v: 'chainlist', label: 'auto (chainlist.org)' },
    { v: 'drpc', label: 'drpc' },
    { v: 'llamarpc', label: 'llamarpc' },
  ]
  const baseLabels: Partial<Record<RpcProvider, string>> = {}
  for (const o of rpcOptions) baseLabels[o.v] = o.label

  const rpcDropdown = document.createElement('div')
  rpcDropdown.className = 'settings-dropdown'

  const rpcButton = document.createElement('button')
  rpcButton.type = 'button'
  rpcButton.className = 'settings-select settings-dropdown-button'
  rpcButton.addEventListener('click', (e) => {
    e.stopPropagation()
    rpcDropdown.classList.toggle('open')
  })
  rpcButton.addEventListener('mousedown', (e) => e.stopPropagation())

  const rpcMenu = document.createElement('div')
  rpcMenu.className = 'settings-dropdown-menu'
  rpcMenu.addEventListener('click', (e) => e.stopPropagation())

  const itemEls: Partial<Record<RpcProvider, HTMLButtonElement>> = {}
  for (const o of rpcOptions) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'settings-dropdown-item'
    item.textContent = o.label
    item.addEventListener('mousedown', (e) => e.stopPropagation())
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      const next = o.v
      if (next !== getGlobalRpcProvider()) {
        setGlobalRpcProvider(next)
        onRpcChange()
        void primeAndRefreshRpcLatency({ force: next === 'chainlist' })
      }
      refreshRpcButton()
      rpcDropdown.classList.remove('open')
    })
    rpcMenu.appendChild(item)
    itemEls[o.v] = item
  }

  rpcDropdown.append(rpcButton, rpcMenu)

  const rpcMsBox = document.createElement('div')
  rpcMsBox.className = 'settings-ms'
  rpcMsBox.textContent = '…'

  function refreshRpcButton() {
    const v = getGlobalRpcProvider()
    rpcButton.textContent = baseLabels[v] ?? v
    for (const o of rpcOptions) {
      const item = itemEls[o.v]
      if (!item) continue
      item.classList.toggle('active', o.v === v)
    }
  }

  function refreshMsBox(ms: number | null) {
    rpcMsBox.textContent = typeof ms === 'number' ? `~${Math.round(ms)}ms` : '—'
  }

  async function primeAndRefreshRpcLatency(opts: { force?: boolean } = {}) {
    const chainId = getFromChainId()
    const provider = getGlobalRpcProvider()
    if (opts.force) rpcMsBox.textContent = '…'
    const ms = await primeRpcProviderLatency(chainId, provider, opts)
    refreshMsBox(ms)
  }
  refreshRpcButton()
  void primeAndRefreshRpcLatency({ force: true })

  const rpcLeft = document.createElement('div')
  rpcLeft.className = 'settings-rpc-left'
  rpcLeft.append(rpcLabel, rpcMsBox)
  rpcRow.append(rpcLeft, rpcDropdown)

  const customHead = document.createElement('div')
  customHead.className = 'settings-subhead'
  customHead.textContent = 'custom rpc'

  const customList = document.createElement('div')
  customList.className = 'settings-list'

  const customInputs: Array<{ chainId: number; input: HTMLInputElement }> = []

  function commitCustomRpc(chainId: number, input: HTMLInputElement) {
    const before = getCustomRpcUrl(chainId)
    setCustomRpcUrl(chainId, input.value)
    const after = getCustomRpcUrl(chainId)
    // Ensure the UI reflects the sanitized value (or clears on invalid).
    input.value = after
    if (after !== before) onRpcChange()
  }

  for (const c of chains) {
    const row = document.createElement('div')
    row.className = 'settings-row'
    const label = document.createElement('span')
    label.className = 'settings-chain'
    label.textContent = c.name
    label.title = c.name
    const input = document.createElement('input')
    input.className = 'settings-input'
    input.type = 'text'
    input.placeholder = 'https://…'
    input.value = getCustomRpcUrl(c.id)
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('change', () => commitCustomRpc(c.id, input))
    input.addEventListener('blur', () => commitCustomRpc(c.id, input))
    row.append(label, input)
    customList.appendChild(row)
    customInputs.push({ chainId: c.id, input })
  }

  settingsTip.append(rpcRow, customHead, customList)
  settingsWrap.append(settingsBtn, settingsTip)

  let rpcLatencyTimer: number | null = null

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    settingsWrap.classList.toggle('active')
    settingsBtn.setAttribute('aria-expanded', settingsWrap.classList.contains('active') ? 'true' : 'false')
    rpcDropdown.classList.remove('open')
    refreshRpcButton()
    void primeAndRefreshRpcLatency({ force: true })

    if (settingsWrap.classList.contains('active')) {
      if (rpcLatencyTimer !== null) window.clearInterval(rpcLatencyTimer)
      rpcLatencyTimer = window.setInterval(() => {
        void primeAndRefreshRpcLatency({ force: true })
      }, 60_000)
    } else {
      if (rpcLatencyTimer !== null) window.clearInterval(rpcLatencyTimer)
      rpcLatencyTimer = null
    }
  })

  window.addEventListener('whichway:rpc-best', (e) => {
    if (getGlobalRpcProvider() !== 'chainlist') return
    const detail = (e as CustomEvent<{ chainId: number; url: string; ms: number }>).detail
    if (!detail || typeof detail.ms !== 'number') return
    refreshMsBox(detail.ms)
  })
  document.addEventListener('click', (e) => {
    const t = e.target
    if (t instanceof Node && settingsWrap.contains(t)) return

    // Validate/sanitize any pending custom RPC input before closing.
    if (settingsWrap.classList.contains('active')) {
      for (const { chainId, input } of customInputs) {
        commitCustomRpc(chainId, input)
      }
    }

    settingsWrap.classList.remove('active')
    settingsWrap.classList.remove('hovering')
    settingsBtn.setAttribute('aria-expanded', 'false')
    if (hoverCloseTimer !== null) window.clearTimeout(hoverCloseTimer)
    hoverCloseTimer = null
    if (rpcLatencyTimer !== null) window.clearInterval(rpcLatencyTimer)
    rpcLatencyTimer = null
  })

  // Single-row layout: about · providers · settings · agent
  const agentSep = document.createElement('span')
  agentSep.className = 'footer-sep'
  setTrustedSvg(agentSep, iconDot(8))

  const agentWrap = document.createElement('div')
  agentWrap.className = 'footer-agent-wrap'

  const agentBtn = document.createElement('a')
  agentBtn.className = 'footer-agent-trigger'
  agentBtn.textContent = 'agent'
  agentBtn.href = '/SKILL.md'
  agentBtn.target = '_blank'
  agentBtn.rel = 'noopener'

  const agentTip = document.createElement('div')
  agentTip.className = 'agent-tooltip'
  const agentLine1 = document.createElement('div')
  agentLine1.textContent = 'human? keep using the ui above.'
  const agentLine2 = document.createElement('div')
  agentLine2.innerHTML = 'agent? read [<a href="/SKILL.md" target="_blank" rel="noopener">SKILL.md</a>] for headless instructions.'
  agentTip.append(agentLine1, agentLine2)

  agentWrap.append(agentBtn, agentTip)

  footer.append(aboutWrap, sep, footerProvidersWrap, settingsSep, settingsWrap, agentSep, agentWrap)
  return footer
}
