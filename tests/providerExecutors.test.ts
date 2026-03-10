import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeParams, OnStep, Route } from '../src/core/types'

vi.mock('../src/providers/cctp', () => ({
  executeCCTP: vi.fn().mockResolvedValue({ success: true, txHash: '0xcctp' }),
  executeCCTPSlow: vi.fn().mockResolvedValue({ success: true, txHash: '0xcctpslow', pending: true }),
}))
vi.mock('../src/providers/usdt0', () => ({
  executeUSDT0: vi.fn().mockResolvedValue({ success: true, txHash: '0xusdt0' }),
}))
vi.mock('../src/providers/across', () => ({
  executeAcross: vi.fn().mockResolvedValue({ success: true, txHash: '0xacross' }),
}))
vi.mock('../src/providers/relay', () => ({
  executeRelay: vi.fn().mockResolvedValue({ success: true, txHash: '0xrelay' }),
}))
vi.mock('../src/providers/debridge', () => ({
  executeDebridge: vi.fn().mockResolvedValue({ success: true, txHash: '0xdebridge' }),
}))
vi.mock('../src/providers/eco', () => ({
  executeEco: vi.fn().mockResolvedValue({ success: true, txHash: '0xeco' }),
}))
vi.mock('../src/providers/gaszip', () => ({
  executeGasZip: vi.fn().mockResolvedValue({ success: true, txHash: '0xgaszip' }),
}))
vi.mock('../src/providers/stargate', () => ({
  executeStargate: vi.fn().mockResolvedValue({ success: true, txHash: '0xstargate' }),
}))
vi.mock('../src/providers/cbridge', () => ({
  executeCbridge: vi.fn().mockResolvedValue({ success: true, txHash: '0xcbridge' }),
}))
vi.mock('../src/providers/synapse', () => ({
  executeSynapse: vi.fn().mockResolvedValue({ success: true, txHash: '0xsynapse' }),
}))
vi.mock('../src/providers/orbiter', () => ({
  executeOrbiter: vi.fn().mockResolvedValue({ success: true, txHash: '0xorbiter' }),
}))
vi.mock('../src/providers/mayan', () => ({
  executeMayan: vi.fn().mockResolvedValue({ success: true, txHash: '0xmayan' }),
}))

import { executeProvider } from '../src/core/provider-executors'
import { executeCCTP, executeCCTPSlow } from '../src/providers/cctp'
import { executeUSDT0 } from '../src/providers/usdt0'
import { executeAcross } from '../src/providers/across'
import { executeRelay } from '../src/providers/relay'
import { executeDebridge } from '../src/providers/debridge'
import { executeEco } from '../src/providers/eco'
import { executeGasZip } from '../src/providers/gaszip'
import { executeStargate } from '../src/providers/stargate'
import { executeCbridge } from '../src/providers/cbridge'
import { executeSynapse } from '../src/providers/synapse'
import { executeOrbiter } from '../src/providers/orbiter'
import { executeMayan } from '../src/providers/mayan'

function makeRoute(provider: string, providerData: unknown = { quoteId: 'q-1' }): Route {
  return {
    type: 'direct',
    provider,
    steps: [{
      action: 'bridge',
      provider,
      fromToken: 'USDC',
      toToken: 'USDC',
      fromChain: 1,
      toChain: 8453,
      amountIn: '1000000',
      amountOut: '999000',
      gasCostUSD: 0.1,
      feeUSD: 0.1,
      estimatedTime: 60,
    }],
    totalCostUSD: 0.2,
    estimatedTime: 60,
    amountReceived: '999000',
    amountReceivedUSD: 0.999,
    quoteExpiresAt: Date.now() + 60_000,
    _providerData: providerData,
  }
}

const params: BridgeParams = {
  fromChainId: 1,
  toChainId: 8453,
  token: 'USDC',
  amount: '1000000',
  userAddress: '0x1111111111111111111111111111111111111111',
}

const onStep: OnStep = vi.fn()

describe('executeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches CCTP Fast with providerData', async () => {
    const route = makeRoute('CCTP Fast')
    await executeProvider('CCTP Fast', params, route, onStep)

    expect(executeCCTP).toHaveBeenCalledTimes(1)
    expect(executeCCTP).toHaveBeenCalledWith(params, onStep, route._providerData)
  })

  it('dispatches CCTP Slow with providerData', async () => {
    const route = makeRoute('CCTP Slow')
    await executeProvider('CCTP Slow', params, route, onStep)

    expect(executeCCTPSlow).toHaveBeenCalledTimes(1)
    expect(executeCCTPSlow).toHaveBeenCalledWith(params, onStep, route._providerData)
  })

  it('dispatches Across with providerData', async () => {
    const route = makeRoute('Across', { orderId: 'abc' })
    await executeProvider('Across', params, route, onStep)

    expect(executeAcross).toHaveBeenCalledTimes(1)
    expect(executeAcross).toHaveBeenCalledWith(params, onStep, route._providerData)
  })

  it('dispatches all providerData-based executors', async () => {
    const directCases: Array<{ provider: string; executor: ReturnType<typeof vi.fn> }> = [
      { provider: 'USDT0', executor: executeUSDT0 as unknown as ReturnType<typeof vi.fn> },
    ]

    for (const { provider, executor } of directCases) {
      const route = makeRoute(provider, { provider })
      await executeProvider(provider, params, route, onStep)
      expect(executor).toHaveBeenCalledWith(params, onStep)
    }

    const providerDataCases: Array<{ provider: string; executor: ReturnType<typeof vi.fn> }> = [
      { provider: 'Relay', executor: executeRelay as unknown as ReturnType<typeof vi.fn> },
      { provider: 'deBridge', executor: executeDebridge as unknown as ReturnType<typeof vi.fn> },
      { provider: 'Eco', executor: executeEco as unknown as ReturnType<typeof vi.fn> },
      { provider: 'Gas.zip', executor: executeGasZip as unknown as ReturnType<typeof vi.fn> },
      { provider: 'cBridge', executor: executeCbridge as unknown as ReturnType<typeof vi.fn> },
      { provider: 'Synapse', executor: executeSynapse as unknown as ReturnType<typeof vi.fn> },
      { provider: 'Orbiter', executor: executeOrbiter as unknown as ReturnType<typeof vi.fn> },
      { provider: 'Mayan Swift', executor: executeMayan as unknown as ReturnType<typeof vi.fn> },
      { provider: 'Mayan WH', executor: executeMayan as unknown as ReturnType<typeof vi.fn> },
    ]

    for (const { provider, executor } of providerDataCases) {
      const route = makeRoute(provider, { provider })
      await executeProvider(provider, params, route, onStep)
      expect(executor).toHaveBeenCalledWith(params, onStep, route._providerData)
    }
  })

  it('dispatches Stargate Taxi with correct mode', async () => {
    const route = makeRoute('Stargate Taxi', { path: 'taxi' })
    await executeProvider('Stargate Taxi', params, route, onStep)

    expect(executeStargate).toHaveBeenCalledTimes(1)
    expect(executeStargate).toHaveBeenCalledWith(params, 'Stargate Taxi', onStep, route._providerData)
  })

  it('dispatches Stargate Bus with correct mode', async () => {
    const route = makeRoute('Stargate Bus', { path: 'bus' })
    await executeProvider('Stargate Bus', params, route, onStep)

    expect(executeStargate).toHaveBeenCalledWith(params, 'Stargate Bus', onStep, route._providerData)
  })

  it('dispatches Mayan variants through executeMayan', async () => {
    const route = makeRoute('Mayan MCTP', { kind: 'mctp' })
    await executeProvider('Mayan MCTP', params, route, onStep)

    expect(executeMayan).toHaveBeenCalledTimes(1)
    expect(executeMayan).toHaveBeenCalledWith(params, onStep, route._providerData)
  })

  it('returns failure for unknown provider', async () => {
    const route = makeRoute('Unknown Provider')
    const result = await executeProvider('Unknown Provider', params, route, onStep)
    expect(result).toEqual({ success: false })
  })
})
