export function setupAgentInputListener(onSelectRoute: (provider: string) => void): void {
  window.addEventListener('agent-select-route', ((e: CustomEvent) => {
    const provider = e.detail?.provider
    if (typeof provider === 'string' && /^[a-z0-9-]+$/.test(provider)) {
      onSelectRoute(provider)
    }
  }) as EventListener)
}
