// TODO: raise this limit after beta testing is complete
export const MAX_BRIDGE_USD = 100

import { CHAIN_ID } from './chains'

export const ACROSS_BASE_URL = 'https://app.across.to/api'

export const QUOTE_TTL_BRIDGE = 60_000 // 60s

// Known contract addresses for calldata validation.
// tx.to must be in this set before we let the user sign.
// CCTP TokenMessengerV2 is deployed via CREATE2 — same address on all supported chains.
// Verified against Circle's official docs: https://developers.circle.com/stablecoins/evm-smart-contracts

// Shared addresses (deployed at same address across multiple chains via CREATE2 or deterministic deploy)
const RAGG            = '0x85d5b2202b2c79867048C1D6C8345933B506EE96'
const CCTP_MESSENGER  = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const CCTP_XMIT       = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64'
const RELAY_DEPOSIT   = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const RELAY_SOLVER    = '0xf70da97812cb96acdf810712aa562db8dfa3dbef'
const GASZIP          = '0x391E7C679d29bD940d63be94AD22A25d25b5A604'
const DEBRIDGE_DLN    = '0xeF4fB24aD0916217251F553c0596F8Edc630EB66'
const DEBRIDGE_ROUTER = '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251'
const ECO             = '0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97'
const SYN_CCTP        = '0xd5a597d6e7ddf373a92C8f477DAAA673b0902F48'
const SYN_FAST        = '0x512000a034E154908Efb1eC48579F4ffDb000512'
const ORBITER         = '0xe530d28960d48708ccf3e62aa7b42a80bc427aef'
const MAYAN           = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2'

// Shared groups
const COMMON   = [RAGG, RELAY_DEPOSIT, RELAY_SOLVER, GASZIP]
const CCTP     = [CCTP_MESSENGER, CCTP_XMIT]
const DEBRIDGE = [DEBRIDGE_DLN, DEBRIDGE_ROUTER]
const SYNAPSE  = [SYN_CCTP, SYN_FAST]

export const KNOWN_CONTRACTS: Record<number, Set<string>> = {
  [CHAIN_ID.ETHEREUM]: new Set([
    ...COMMON, ...CCTP, ...DEBRIDGE, ...SYNAPSE, ECO, ORBITER, MAYAN,
    '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', // Across SpokePool
    '0xc026395860Db2d07ee33e05fE50ed7bD583189C7', // Stargate PoolUSDC
    '0x933597a323Eb81cAe705C5bC29985172fd5A3973', // Stargate PoolUSDT
    '0x77b2043768d28E9C9aB44E1aBfC95944bcE57931', // Stargate PoolNative
    '0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820', // cBridge
    '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee', // USDT0 OFT Adapter
  ]),
  [CHAIN_ID.BASE]: new Set([
    ...COMMON, ...CCTP, ...DEBRIDGE, ...SYNAPSE, ECO, ORBITER, MAYAN,
    '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64', // Across SpokePool
    '0x27a16dc786820B16E5c9028b75B99F6f604b5d26', // Stargate PoolUSDC
    '0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7', // Stargate PoolNative
    '0x7d43AABC515C356145049227CeE54B608342c0ad', // cBridge
  ]),
  [CHAIN_ID.ARBITRUM]: new Set([
    ...COMMON, ...CCTP, ...DEBRIDGE, ...SYNAPSE, ECO, ORBITER, MAYAN,
    '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A', // Across SpokePool
    '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3', // Stargate PoolUSDC
    '0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0', // Stargate PoolUSDT
    '0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F', // Stargate PoolNative
    '0x1619DE6B6B20eD217a58d00f37B9d47C7663feca', // cBridge
    '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', // USDT0 OFT
  ]),
  [CHAIN_ID.OPTIMISM]: new Set([
    ...COMMON, ...CCTP, ...DEBRIDGE, ...SYNAPSE, ECO, ORBITER, MAYAN,
    '0x6f26Bf09B1C792e3228e5467807a900A503c0281', // Across SpokePool
    '0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0', // Stargate PoolUSDC
    '0x19cFCE47eD54a88614648DC3f19A5980097007dD', // Stargate PoolUSDT
    '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3', // Stargate PoolNative
    '0x9D39Fc627A6d9d9F8C831c16995b209548cc3401', // cBridge
    '0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD', // USDT0 OFT
  ]),
  [CHAIN_ID.POLYGON]: new Set([
    ...COMMON, ...CCTP, ...DEBRIDGE, ...SYNAPSE, ECO, ORBITER, MAYAN,
    '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096', // Across SpokePool
    '0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4', // Stargate PoolUSDC
    '0xd47b03ee6d86Cf251ee7860FB2ACf9f91B9fD4d7', // Stargate PoolUSDT
    '0x88DCDC47D2f83a99CF0000FDF667A468bB958a78', // cBridge
    '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13', // USDT0 OFT
  ]),
  [CHAIN_ID.HYPEREVM]: new Set([
    ...COMMON, ...CCTP, MAYAN,
    '0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04', // Across SpokePool
    '0xB8CE59fc3717ada4c02eadf9682a9E934F625Ebb', // USDT0 Token
    '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98', // USDT0 OFT
  ]),
  [CHAIN_ID.BSC]: new Set([
    ...COMMON, ...DEBRIDGE, ...SYNAPSE, ORBITER, MAYAN,
    '0x4e8E101924eDE233C13e2D8622DC8aED2872d505', // Across SpokePool
    '0x962Bd449E630b0d928f308Ce63f1A21F02576057', // Stargate PoolUSDC
    '0x138EB30f73BC423c6455C53df6D89CB01d9eBc63', // Stargate PoolUSDT
    '0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF', // cBridge
  ]),
  [CHAIN_ID.INK]: new Set([
    ...COMMON, ...CCTP, ECO, ORBITER,
    '0xeF684C38F94F48775959ECf2012D7E864ffb9dd4', // Across SpokePool
    '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590', // Stargate OFT USDC.e
    '0x1cB6De532588fCA4a21B7209DE7C456AF8434A65', // Stargate OFT USDT / USDT0 OFT
    '0x0200C29006150606B650577BBE7B6248F58470c1', // USDT0 Token
  ]),
}

// Pre-lowercased for O(1) lookup — built once at module load
const KNOWN_CONTRACTS_LOWER: Record<number, Set<string>> = Object.fromEntries(
  Object.entries(KNOWN_CONTRACTS).map(([chainId, set]) => [
    Number(chainId),
    new Set([...set].map(a => a.toLowerCase())),
  ]),
)

export function isKnownContract(chainId: number, address: string): boolean {
  const set = KNOWN_CONTRACTS_LOWER[chainId]
  if (!set) return false
  return set.has(address.toLowerCase())
}

export const REFERRAL_ADDRESS = '0x1ad0616798839b9D691a7281CE912CD5c0212329'

const CALLDATA_TAG = '77686963682e776569' // "which.wei" in hex

export function tagCalldata(data: string): string {
  return `${data}${CALLDATA_TAG}`
}
