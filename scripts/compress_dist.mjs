import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { join } from 'node:path'

const DIST_DIR = new URL('../dist', import.meta.url)
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt'])

function hasCompressibleExtension(path) {
  for (const ext of COMPRESSIBLE_EXTENSIONS) {
    if (path.endsWith(ext)) return true
  }
  return false
}

async function collectFiles(dirPath) {
  const entries = await readdir(dirPath)
  const files = []

  for (const entry of entries) {
    const fullPath = join(dirPath, entry)
    const info = await stat(fullPath)
    if (info.isDirectory()) {
      files.push(...await collectFiles(fullPath))
      continue
    }

    if (!entry.endsWith('.br') && hasCompressibleExtension(entry)) {
      files.push(fullPath)
    }
  }

  return files
}

async function main() {
  const distPath = DIST_DIR.pathname
  const files = await collectFiles(distPath)
  let compressedCount = 0

  for (const filePath of files) {
    const content = await readFile(filePath)
    const compressed = brotliCompressSync(content, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    })
    await writeFile(`${filePath}.br`, compressed)
    compressedCount += 1
  }

  console.log(`[compress] wrote ${compressedCount} .br files in dist/`)
}

main().catch((error) => {
  console.error('[compress] brotli compression failed:', error)
  process.exit(1)
})
