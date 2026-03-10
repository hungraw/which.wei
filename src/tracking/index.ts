/**
 * Tracking module — exports all tracking functionality
 */

export type { TrackedBridge, TrackingStatus, PollResult } from './types'
export {
  loadActiveBridges,
  addBridge,
  updateBridge,
  getBridgeByTxHash,
  getActiveBridges,
} from './store'

export {
  startPolling,
  resumePolling,
  setBalanceGetter,
  BRIDGE_UPDATE_EVENT,
} from './manager'
