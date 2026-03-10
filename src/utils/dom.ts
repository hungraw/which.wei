export function clearChildren(el: Element): void {
  // replaceChildren is widely supported and avoids HTML parsing.
  if (typeof el.replaceChildren === 'function') {
    el.replaceChildren()
    return
  }
  while (el.firstChild) el.removeChild(el.firstChild)
}

function isLikelySafeSvgMarkup(svgMarkup: string): boolean {
  const s = svgMarkup.trim()
  if (!s.startsWith('<svg')) return false

  // Basic sink hardening: block scripts, event handlers, foreignObject, and javascript: URLs.
  if (/<script[\s>]/i.test(s)) return false
  if (/<foreignObject[\s>]/i.test(s)) return false
  if (/\son[a-z]+\s*=\s*['"]/i.test(s)) return false
  if (/javascript\s*:/i.test(s)) return false

  return true
}

function parseSvg(svgMarkup: string): SVGElement | null {
  const s = svgMarkup.trim()

  // Prefer SVG parsing context.
  try {
    if (typeof DOMParser !== 'undefined') {
      const doc = new DOMParser().parseFromString(s, 'image/svg+xml')
      const root = doc.documentElement
      if (!root || root.nodeName.toLowerCase() !== 'svg') return null
      return document.importNode(root, true) as unknown as SVGElement
    }
  } catch {
    // fall through
  }

  // Fallback: HTML template parsing (still guarded by isLikelySafeSvgMarkup()).
  try {
    const t = document.createElement('template')
    t.innerHTML = s
    const node = t.content.firstElementChild
    if (node && node.tagName.toLowerCase() === 'svg') return node as unknown as SVGElement
  } catch {
  }

  return null
}

export function setTrustedSvg(el: HTMLElement, svgMarkup: string): void {
  clearChildren(el)
  if (!isLikelySafeSvgMarkup(svgMarkup)) return
  const svg = parseSvg(svgMarkup)
  if (!svg) return
  el.appendChild(svg)
}

export function appendTrustedSvg(el: HTMLElement, svgMarkup: string): void {
  if (!isLikelySafeSvgMarkup(svgMarkup)) return
  const svg = parseSvg(svgMarkup)
  if (!svg) return
  el.appendChild(svg)
}
