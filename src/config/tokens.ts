import type { Token } from '../core/types'
import { ICON_USDC, ICON_USDT, ICON_USDT0_ASSET, ICON_ETH } from './token-icons'
import { isUSDT0Supported } from './chains'

export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

/** Zero address — used by some providers for native tokens */
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

export const STABLECOINS = new Set(['USDC', 'USDT', 'USDT0', 'DAI', 'BUSD', 'TUSD', 'USDCE'])

export const tokens: Token[] = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    icon: ICON_USDC,
    chains: {
      1:     { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      8453:  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      42161: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      10:    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      137:   { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      999:   { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6 },
      56:    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }, // Binance-Peg
      57073: { address: '0x2D270e6886d130D724215A266106e6832161EAEd', decimals: 6 },
    },
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    icon: ICON_USDT,
    chains: {
      1:     { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      8453:  { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
      42161: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      10:    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },  // Legacy bridged USDT
      137:   { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      56:    { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 }, // Binance-Peg
    },
  },
  {
    symbol: 'USDT0',
    name: 'USDT0',
    icon: ICON_USDT0_ASSET,
    chains: {
      1:     { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },  // OFT Adapter wraps legacy USDT
      42161: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },  // Upgraded in-place
      10:    { address: '0x01bFF41798a0BcF287b996046Ca68b395DbC1071', decimals: 6 },  // Native USDT0
      137:   { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },  // Upgraded in-place
      999:   { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6 },  // Native USDT0
      57073: { address: '0x0200C29006150606B650577BBE7B6248F58470c1', decimals: 6 },  // Native USDT0
    },
  },
  {
    symbol: 'ETH',
    name: 'Ether',
    icon: ICON_ETH,
    chains: {
      1:     { address: NATIVE, decimals: 18 },
      8453:  { address: NATIVE, decimals: 18 },
      42161: { address: NATIVE, decimals: 18 },
      10:    { address: NATIVE, decimals: 18 },
      137:   { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 }, // WETH on Polygon
      // HyperEVM (999) intentionally omitted — native is HYPE, not ETH.
      // There is no wrapped/bridged ETH on HyperEVM.
      57073: { address: NATIVE, decimals: 18 },
    },
  },
]

export const tokenBySymbol = new Map(tokens.map(t => [t.symbol, t]))

export function getTokenAddress(symbol: string, chainId: number): string | null {
  const token = tokenBySymbol.get(symbol)
  return token?.chains[chainId]?.address ?? null
}

export function getTokenDecimals(symbol: string, chainId: number): number | null {
  const token = tokenBySymbol.get(symbol)
  return token?.chains[chainId]?.decimals ?? null
}

export function tokensForChainPair(fromChainId: number, toChainId: number): Token[] {
  return tokens.filter(t => {
    if (fromChainId in t.chains && toChainId in t.chains) return true
    // USDT0 can bridge to any USDT0-supported chain via the OFT bridge,
    // even if the destination lists the token as 'USDT' (upgraded in-place).
    if (t.symbol === 'USDT0' && fromChainId in t.chains && isUSDT0Supported(toChainId)) return true
    return false
  })
}
