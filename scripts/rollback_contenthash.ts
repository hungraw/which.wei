/**
 * Rollback which.wei contenthash to a specific CID.
 * Usage: npx tsx scripts/rollback_contenthash.ts <cid>
 */
import {
  createWalletClient,
  createPublicClient,
  fallback,
  http,
  namehash,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  WEI_RESOLVER,
  DOMAIN,
  MAX_FEE_PER_GAS,
  MAX_PRIORITY_FEE,
  ETH_RPCS,
  RESOLVER_ABI,
  cidToContenthash,
  loadEnv,
} from './common'

// Verify CID is reachable before pointing domain at it
async function verifyIPFSReachable(cid: string): Promise<void> {
  const gateways = [
    `https://ipfs.filebase.io/ipfs/${cid}/`,
    `https://${cid}.ipfs.dweb.link/`,
    `https://ipfs.io/ipfs/${cid}/`,
  ]

  console.log('Verifying CID is reachable on IPFS...')
  for (const url of gateways) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        console.log(`  ✓ Reachable on ${new URL(url).hostname}`)
        return
      }
    } catch {
      // try next
    }
  }

  console.error('  ✗ CID not reachable on any gateway!')
  console.error('  The content may have been garbage-collected.')
  console.error('  Aborting to avoid pointing domain at unreachable content.')
  console.error('  Use --force to override: npx tsx scripts/rollback_contenthash.ts <cid> --force')
  process.exit(1)
}

async function main() {
  const cid = process.argv[2]
  if (!cid || !cid.startsWith('bafy')) {
    console.error('Usage: npx tsx scripts/rollback_contenthash.ts <cid>')
    console.error('  cid must be a CIDv1 base32 string (bafyb...)')
    process.exit(1)
  }

  loadEnv()
  const privateKey = process.env.WEI_DEPLOYER_KEY
  if (!privateKey) {
    console.error('WEI_DEPLOYER_KEY not set in .env')
    process.exit(1)
  }

  console.log(`Rolling back which.wei contenthash to: ${cid}`)

  // Verify CID is still reachable before updating on-chain pointer
  if (process.argv.includes('--force')) {
    console.log('  --force: skipping IPFS reachability check')
  } else {
    await verifyIPFSReachable(cid)
  }

  const contenthash = cidToContenthash(cid)
  const tokenId = BigInt(namehash(DOMAIN))

  const account = privateKeyToAccount(privateKey as Hex)
  const transport = fallback(ETH_RPCS.map(url => http(url, { retryCount: 2, timeout: 15_000 })))
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const walletClient = createWalletClient({ account, chain: mainnet, transport })

  const txHash = await walletClient.writeContract({
    address: WEI_RESOLVER,
    abi: RESOLVER_ABI,
    functionName: 'setContenthash',
    args: [tokenId, contenthash],
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE,
  })

  console.log(`  TX: https://etherscan.io/tx/${txHash}`)
  console.log('  Waiting for confirmation...')

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 300_000 })
  if (receipt.status === 'reverted') {
    console.error(`  TX REVERTED in block ${receipt.blockNumber}!`)
    process.exit(1)
  }
  console.log(`  Confirmed in block ${receipt.blockNumber}`)
  console.log(`  which.wei now points to ipfs://${cid}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
