/// <reference lib="webworker" />
// @ts-nocheck — runs as ServiceWorker, not in TS build

const CACHE_NAME = 'ww-v1'

// Populated at build time by Vite plugin (replaced in dist/sw.js)
const PRECACHE_URLS = self.__WW_PRECACHE || []

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Only handle same-origin GET requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return

  // HTML navigation: network-first (picks up new deploys), cache fallback
  if (event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const clone = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        return response
      }).catch(() => caches.match(event.request)),
    )
    return
  }

  // Hashed assets (JS/CSS/images): cache-first (immutable by content hash)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request).then((response) => {
        const clone = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        return response
      })
    }),
  )
})
