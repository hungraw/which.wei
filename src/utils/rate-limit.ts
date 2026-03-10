/**
 * Rate limiting utility for provider API requests.
 *
 * Implements per-provider request throttling to avoid hitting API rate limits.
 * Uses a token bucket algorithm with configurable request limits per time window.
 */

export interface RateLimitConfig {
  /** Max requests allowed in the time window */
  maxRequests: number
  /** Time window in milliseconds */
  windowMs: number
}

/** Default: 2 requests per second per provider */
const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 2,
  windowMs: 1000,
}

const requestTimestamps = new Map<string, number[]>()

const providerConfigs = new Map<string, RateLimitConfig>()

export function setProviderRateLimit(provider: string, config: RateLimitConfig): void {
  providerConfigs.set(provider.toLowerCase(), config)
}

function getConfig(provider: string): RateLimitConfig {
  return providerConfigs.get(provider.toLowerCase()) || DEFAULT_CONFIG
}

function cleanupTimestamps(provider: string, config: RateLimitConfig): number[] {
  const now = Date.now()
  const cutoff = now - config.windowMs
  const timestamps = requestTimestamps.get(provider) || []
  const valid = timestamps.filter(t => t > cutoff)
  requestTimestamps.set(provider, valid)
  return valid
}

export function getRateLimitDelay(provider: string): number {
  const key = provider.toLowerCase()
  const config = getConfig(key)
  const timestamps = cleanupTimestamps(key, config)

  if (timestamps.length < config.maxRequests) {
    return 0
  }

  // Need to wait until oldest request expires from window
  const oldest = timestamps[0]
  const waitUntil = oldest + config.windowMs
  const delay = waitUntil - Date.now()
  return Math.max(0, delay)
}

export function recordRequest(provider: string): void {
  const key = provider.toLowerCase()
  const config = getConfig(key)
  cleanupTimestamps(key, config)
  const timestamps = requestTimestamps.get(key) || []
  timestamps.push(Date.now())
  requestTimestamps.set(key, timestamps)
}

/**
 * Wait if necessary to respect rate limits, then record the request.
 * Use this before making an API call.
 */
export async function waitForRateLimit(provider: string): Promise<void> {
  const delay = getRateLimitDelay(provider)
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  recordRequest(provider)
}

/**
 * Reset rate limit state for a provider (mainly for testing)
 */
export function resetRateLimitState(provider?: string): void {
  if (provider) {
    requestTimestamps.delete(provider.toLowerCase())
  } else {
    requestTimestamps.clear()
  }
}
