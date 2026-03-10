import { readFileSync, readdirSync, unlinkSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import {
  createWalletClient,
  createPublicClient,
  fallback,
  http,
  namehash,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
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

const DIST = join(import.meta.dirname, '..', 'dist')

// Copy dist/ excluding .br files into a clean staging directory
function stageCleanDist(): string {
  const staging = join(DIST, '..', 'dist-clean')
  execSync(`rm -rf ${staging}`)
  copyDir(DIST, staging)
  return staging
}

function copyDir(src: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else if (!entry.name.endsWith('.br')) {
      copyFileSync(srcPath, destPath)
    }
  }
}

// Upload to Filebase via S3 API using CAR file for directory CID
async function pinToFilebase(key: string, secret: string, bucket: string): Promise<string> {
  console.log('\nPinning to Filebase...')

  // Stage a clean directory (no .br files) so CAR is minimal
  const staging = stageCleanDist()
  const carPath = join(DIST, '..', 'dist.car')

  try {
    const carCid = execSync(`npx ipfs-car pack ${staging} --output ${carPath}`, { encoding: 'utf-8' }).trim()
    const carData = readFileSync(carPath)

    const s3 = new S3Client({
      endpoint: 'https://s3.filebase.com',
      region: 'us-east-1',
      credentials: { accessKeyId: key, secretAccessKey: secret },
    })

    let filebaseCid: string | undefined
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: `whichwei-${new Date().toISOString().slice(0, 10)}.car`,
      Body: carData,
      Metadata: { import: 'car' },
    })
    command.middlewareStack.add(
      (next) => async (args) => {
        const response = await next(args)
        if ((response as any).response?.headers) {
          filebaseCid = (response as any).response.headers['x-amz-meta-cid']
        }
        return response
      },
      { step: 'build', name: 'extractCid' },
    )

    await s3.send(command)

    const cid = filebaseCid || carCid
    console.log(`  ✓ Filebase pin: ${cid}`)
    console.log(`  Gateway: https://ipfs.filebase.io/ipfs/${cid}`)
    return cid
  } finally {
    // Clean up temp files
    try { unlinkSync(carPath) } catch {}
    try { execSync(`rm -rf ${staging}`) } catch {}
  }
}

// Verify CID is reachable on public IPFS before updating contenthash
async function verifyIPFSPropagation(cid: string, maxAttempts = 10, intervalMs = 15_000): Promise<void> {
  const gateways = [
    `https://ipfs.filebase.io/ipfs/${cid}/`,
    `https://${cid}.ipfs.dweb.link/`,
    `https://ipfs.io/ipfs/${cid}/`,
  ]

  console.log('\nVerifying IPFS propagation...')
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const url of gateways) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20_000)
        const res = await fetch(url, { method: 'HEAD', signal: controller.signal })
        clearTimeout(timer)
        if (res.ok) {
          const name = new URL(url).hostname
          console.log(`  ✓ CID reachable on ${name} (attempt ${attempt}/${maxAttempts})`)
          return
        }
      } catch {
        // timeout or network error — try next gateway
      }
    }
    if (attempt < maxAttempts) {
      console.log(`  Attempt ${attempt}/${maxAttempts}: not yet reachable, retrying in ${intervalMs / 1000}s...`)
      await new Promise(r => setTimeout(r, intervalMs))
    }
  }

  console.error(`\n  ✗ CID not reachable after ${maxAttempts} attempts!`)
  console.error('  Skipping contenthash update to avoid pointing to unreachable content.')
  console.error(`  CID: ${cid}`)
  console.error('  You can manually update contenthash later with:')
  console.error(`    npx tsx scripts/rollback_contenthash.ts ${cid}`)
  process.exit(1)
}

async function main() {
  loadEnv()

  const fbKey = process.env.FILEBASE_KEY
  const fbSecret = process.env.FILEBASE_SECRET
  const fbBucket = process.env.FILEBASE_BUCKET
  if (!fbKey || !fbSecret || !fbBucket) {
    console.error('FILEBASE_KEY, FILEBASE_SECRET, FILEBASE_BUCKET must be set in .env')
    process.exit(1)
  }

  // Build first
  console.log('Building...')
  execSync('npm run build', { cwd: join(import.meta.dirname, '..'), stdio: 'inherit' })

  // Pin to Filebase — this is the canonical CID
  const cid = await pinToFilebase(fbKey, fbSecret, fbBucket)

  console.log('\nUpload complete!')
  console.log(`  CID:  ${cid}`)
  console.log(`  Public:  https://dweb.link/ipfs/${cid}`)
  console.log(`  Contenthash: ipfs://${cid}`)

  // Write CID for downstream tooling (tagging, rollback reference)
  const { writeFileSync } = await import('fs')
  writeFileSync(join(import.meta.dirname, '..', '.last-deploy-cid'), cid, 'utf-8')

  // Verify CID is accessible on IPFS before updating contenthash
  await verifyIPFSPropagation(cid)

  // Update Wei Name Service contenthash if private key is set
  const privateKey = process.env.WEI_DEPLOYER_KEY
  if (!privateKey) {
    console.log('\n  WEI_DEPLOYER_KEY not set — skipping contenthash update.')
    console.log('  Set it in .env to auto-update which.wei contenthash.')
    return
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('WEI_DEPLOYER_KEY must be a 0x-prefixed 64-char hex string')
    process.exit(1)
  }

  console.log('\nUpdating which.wei contenthash...')
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
    console.error('  Check the deployer wallet owns which.wei and has ETH for gas.')
    process.exit(1)
  }
  console.log(`  Confirmed in block ${receipt.blockNumber}`)

  // Warm the wei.limo gateway cache — retry since IPFS propagation takes a moment
  await warmGateway(3)
}

async function warmGateway(retries: number) {
  console.log('\nWarming which.wei.limo gateway cache...')
  const assetsDir = join(DIST, 'assets')
  const assetFiles = readdirSync(assetsDir)
    .filter((f) => !f.endsWith('.br'))
    .map((f) => `assets/${f}`)
  const urls = ['./', 'favicon.png', 'sw.js', ...assetFiles]

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) {
      console.log(`  Retry ${attempt}/${retries} after 15s...`)
      await new Promise(r => setTimeout(r, 15_000))
    }

    const results = await Promise.allSettled(
      urls.map(async (path) => {
        const res = await fetch(`https://which.wei.limo/${path}`)
        return { path, status: res.status }
      }),
    )

    let ok = 0
    let fail = 0
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.status === 200) {
        ok++
      } else {
        fail++
        if (attempt === retries) {
          const detail = r.status === 'fulfilled' ? r.value.status : (r.reason as Error).message
          console.log(`  WARN: ${r.status === 'fulfilled' ? r.value.path : '?'} → ${detail}`)
        }
      }
    }

    if (fail === 0) {
      console.log(`  ${ok}/${urls.length} assets cached`)
      return
    }

    if (attempt === retries) {
      console.log(`  ${ok}/${urls.length} assets cached (${fail} failed after ${retries} attempts)`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
