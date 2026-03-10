import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Inject strict CSP meta tag in production builds only. */
function cspPlugin(): Plugin {
  const CSP = [
    "default-src 'self' https:",
    "base-uri 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src https: wss:",
    "img-src 'self' data: https:",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ')

  return {
    name: 'inject-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (ctx.server) return html // dev — no CSP (Vite needs ws://localhost + http://localhost)
        // prod — inject strict CSP after <meta charset>
        return html.replace(
          '<!-- CSP is injected by Vite plugin (strict in prod, permissive in dev) -->',
          `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        )
      },
    },
  }
}

/** Inject precache manifest into sw.js after build. */
function swManifestPlugin(): Plugin {
  return {
    name: 'sw-precache-manifest',
    apply: 'build',
    closeBundle() {
      const distDir = join(__dirname, 'dist')
      const assetsDir = join(distDir, 'assets')
      const assetFiles = readdirSync(assetsDir)
        .filter((f) => !f.endsWith('.br'))
        .map((f) => `./assets/${f}`)
      const precacheUrls = ['./', './index.html', './favicon.png', ...assetFiles]

      const swPath = join(distDir, 'sw.js')
      const swSource = readFileSync(swPath, 'utf-8')
      const patched = swSource.replace(
        'self.__WW_PRECACHE || []',
        JSON.stringify(precacheUrls),
      )
      writeFileSync(swPath, patched, 'utf-8')
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [cspPlugin(), swManifestPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',         // entry point with DOM setup — integration scope
        'src/style.css',
        'src/providers/**',    // API-calling modules — need integration tests
        'src/ui/**',           // DOM-heavy UI modules — integration scope
        'src/tracking/**',     // polling/stateful runtime orchestration
        'src/wallet/transactions.ts', // end-to-end signing path
        'src/wallet/connect.ts',       // wagmi config initialization
        'src/wallet/chain-switch.ts',  // wallet chain switching
        'src/utils/rpc.ts',            // network probing/failover integration
        'src/utils/poll.ts',           // runtime polling helper
        'src/core/types.ts',           // mostly type definitions
        'src/utils/balance.ts',        // wagmi readContract calls
      ],
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 50,
        statements: 60,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/zod/')) {
              return 'schema'
            }
            if (id.includes('@wagmi/core') || id.includes('/viem/') || id.includes('/ox/') || id.includes('/abitype/')) {
              return 'wallet'
            }
            return 'vendor'
          }

          if (id.includes('/src/providers/') || id.includes('/src/wallet/transactions')) {
            return 'providers'
          }
        },
      },
    },
  },
})
