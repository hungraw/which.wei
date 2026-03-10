import type { BridgeParams, ExecuteResult, OnStep, Route } from './types'

type ProviderExecutor = (
  params: BridgeParams,
  onStep: OnStep,
  route: Route,
) => Promise<ExecuteResult>

const mayanExecutor: ProviderExecutor = async (p, s, r) => (await import('../providers/mayan')).executeMayan(p, s, r._providerData)

const PROVIDER_EXECUTORS: Record<string, ProviderExecutor> = {
  'CCTP Fast': async (p, s, r) => (await import('../providers/cctp')).executeCCTP(p, s, r._providerData),
  'CCTP Slow': async (p, s, r) => (await import('../providers/cctp')).executeCCTPSlow(p, s, r._providerData),
  'USDT0': async (p, s) => (await import('../providers/usdt0')).executeUSDT0(p, s),
  'Across': async (p, s, r) => (await import('../providers/across')).executeAcross(p, s, r._providerData),
  'Relay': async (p, s, r) => (await import('../providers/relay')).executeRelay(p, s, r._providerData),
  'deBridge': async (p, s, r) => (await import('../providers/debridge')).executeDebridge(p, s, r._providerData),
  'Eco': async (p, s, r) => (await import('../providers/eco')).executeEco(p, s, r._providerData),
  'Gas.zip': async (p, s, r) => (await import('../providers/gaszip')).executeGasZip(p, s, r._providerData),
  'Stargate Taxi': async (p, s, r) => (await import('../providers/stargate')).executeStargate(p, 'Stargate Taxi', s, r._providerData),
  'Stargate Bus': async (p, s, r) => (await import('../providers/stargate')).executeStargate(p, 'Stargate Bus', s, r._providerData),
  'cBridge': async (p, s, r) => (await import('../providers/cbridge')).executeCbridge(p, s, r._providerData),
  'Synapse': async (p, s, r) => (await import('../providers/synapse')).executeSynapse(p, s, r._providerData),
  'Orbiter': async (p, s, r) => (await import('../providers/orbiter')).executeOrbiter(p, s, r._providerData),
  'Mayan Swift': mayanExecutor,
  'Mayan MCTP': mayanExecutor,
  'Mayan WH': mayanExecutor,
}

export async function executeProvider(
  provider: string,
  params: BridgeParams,
  route: Route,
  onStep: OnStep,
): Promise<ExecuteResult> {
  const executor = PROVIDER_EXECUTORS[provider]
  if (!executor) return { success: false }
  return executor(params, onStep, route)
}
