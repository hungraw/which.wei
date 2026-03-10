export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError'
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return msg.includes('abort') || msg.includes('aborted') || msg.includes('timed out')
  }
  return false
}

export function isUserRejectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('user rejected')
    || msg.includes('rejected the request')
    || msg.includes('action_rejected')
}
