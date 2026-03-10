/**
 * Tracking store — localStorage CRUD for active bridge orders.
 */

import type { TrackedBridge } from './types'
import { z } from 'zod'

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

const TrackedBridgeSchema = z.object({
  id: z.string().min(1).max(120),
  txHash: z.string().regex(TX_HASH_RE),
  provider: z.string().min(1).max(40),
  token: z.string().min(1).max(16),
  fromChainId: z.number().int().finite(),
  toChainId: z.number().int().finite(),
  amountIn: z.string().max(96),
  amountOut: z.string().max(96),
  userAddress: z.string().regex(ADDRESS_RE),
  status: z.enum(['sent', 'processing', 'completed', 'failed', 'unconfirmed', 'claim-ready']),
  startedAt: z.number().int().finite(),
  estimatedTime: z.number().finite(),
  completedAt: z.number().int().finite().optional(),
  fillTxHash: z.string().regex(TX_HASH_RE).optional(),
  providerOrderId: z.string().max(120).optional(),
  explorerUrl: z.string().max(300).optional(),
  destExplorerUrl: z.string().max(300).optional(),
  lastError: z.string().max(220).optional(),
  lastErrorAt: z.number().int().finite().optional(),
  errorCount: z.number().int().min(0).max(99).optional(),
  providerEtaSec: z.number().int().min(0).max(60 * 60 * 48).optional(),
  providerStatusText: z.string().max(120).optional(),
  preBalance: z.string().max(96).optional(),
  destTokenAddress: z.string().max(120).optional(),
  cctpMessage: z.string().max(4000).optional(),
  cctpAttestation: z.string().max(4000).optional(),
}).passthrough()

const TrackedBridgesSchema = z.array(TrackedBridgeSchema)

const STORAGE_KEY = 'whichwei:active-bridges'
const MAX_ACTIVE = 20
const COMPLETED_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

function migrateProviderName(provider: string): string {
  // Back-compat for older stored items; normalize to the current naming scheme.
  if (provider === 'Stargate') return 'Stargate Taxi'
  if (provider === 'Mayan') return 'Mayan Swift'
  if (provider === 'CCTP') return 'CCTP Fast'
  return provider
}

/** Load all active bridges from localStorage */
export function loadActiveBridges(): TrackedBridge[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const result = TrackedBridgesSchema.safeParse(parsed)
    if (!result.success) return []

    const bridges = result.data as TrackedBridge[]
    let didMigrate = false
    const migrated = bridges.map(b => {
      const provider = migrateProviderName(b.provider)
      if (provider !== b.provider) didMigrate = true
      return provider === b.provider ? b : { ...b, provider }
    })

    if (didMigrate) saveBridges(migrated)
    return migrated
  } catch {
    return []
  }
}

/** Save bridges to localStorage */
function saveBridges(bridges: TrackedBridge[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bridges))
  } catch {
    // localStorage may be full or blocked
  }
}

/** Add a new bridge to tracking */
export function addBridge(bridge: TrackedBridge): void {
  const bridges = loadActiveBridges()
  
  // Remove duplicate by txHash if exists
  const filtered = bridges.filter(b => b.txHash !== bridge.txHash)
  filtered.unshift(bridge)
  
  // Keep only the most recent MAX_ACTIVE
  if (filtered.length > MAX_ACTIVE) filtered.length = MAX_ACTIVE
  
  saveBridges(filtered)
}

/** Update a bridge by ID */
export function updateBridge(id: string, updates: Partial<TrackedBridge>): void {
  const bridges = loadActiveBridges()
  const idx = bridges.findIndex(b => b.id === id)
  if (idx < 0) return
  
  bridges[idx] = { ...bridges[idx], ...updates }
  saveBridges(bridges)
}

/** Get a bridge by txHash */
export function getBridgeByTxHash(txHash: string): TrackedBridge | undefined {
  return loadActiveBridges().find(b => b.txHash === txHash)
}

/** Max age for bridges stuck in sent/processing before marking unconfirmed (4h) */
const STALE_ACTIVE_MS = 4 * 60 * 60 * 1000

/** Purge expired completed bridges (older than 24h) and mark stale active bridges */
export function purgeExpired(): void {
  const now = Date.now()
  const bridges = loadActiveBridges()
    .map(b => {
      // Mark stale sent/processing bridges as unconfirmed so they stop showing as pending
      if ((b.status === 'sent' || b.status === 'processing') && now - b.startedAt > STALE_ACTIVE_MS) {
        return { ...b, status: 'unconfirmed' as const, completedAt: now }
      }
      return b
    })
    .filter(b => {
      if (b.status !== 'completed' && b.status !== 'failed' && b.status !== 'unconfirmed') return true
      const completedAt = b.completedAt ?? b.startedAt
      return now - completedAt < COMPLETED_EXPIRY_MS
    })
  saveBridges(bridges)
}

/** Get all bridges that need polling (sent or processing) */
export function getActiveBridges(): TrackedBridge[] {
  return loadActiveBridges().filter(b => b.status === 'sent' || b.status === 'processing' || b.status === 'claim-ready')
}

