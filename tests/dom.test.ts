import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendTrustedSvg, clearChildren, setTrustedSvg } from '../src/utils/dom'

class FakeElement {
  children: unknown[] = []
  firstChild: unknown = null

  replaceChildren(): void {
    this.children = []
    this.firstChild = null
  }

  appendChild(node: unknown): void {
    this.children.push(node)
    this.firstChild = this.children[0] ?? null
  }

  removeChild(node: unknown): void {
    this.children = this.children.filter((child) => child !== node)
    this.firstChild = this.children[0] ?? null
  }
}

describe('utils/dom trusted svg helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      importNode: (node: unknown) => node,
      createElement: (tag: string) => {
        if (tag === 'template') {
          return {
            innerHTML: '',
            content: { firstElementChild: { tagName: 'svg' } },
          }
        }
        return new FakeElement()
      },
    })

    class DOMParserMock {
      parseFromString(markup: string) {
        const isSvg = markup.trim().startsWith('<svg')
        return {
          documentElement: { nodeName: isSvg ? 'svg' : 'parsererror' },
        }
      }
    }

    vi.stubGlobal('DOMParser', DOMParserMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setTrustedSvg appends safe svg markup', () => {
    const el = new FakeElement() as unknown as HTMLElement
    setTrustedSvg(el, '<svg viewBox="0 0 1 1"></svg>')
    expect((el as unknown as FakeElement).children).toHaveLength(1)
  })

  it('appendTrustedSvg appends an additional safe svg', () => {
    const el = new FakeElement() as unknown as HTMLElement
    appendTrustedSvg(el, '<svg viewBox="0 0 1 1"></svg>')
    appendTrustedSvg(el, '<svg viewBox="0 0 1 1"></svg>')
    expect((el as unknown as FakeElement).children).toHaveLength(2)
  })

  it('blocks <script> payloads', () => {
    const el = new FakeElement() as unknown as HTMLElement
    setTrustedSvg(el, '<svg><script>alert(1)</script></svg>')
    expect((el as unknown as FakeElement).children).toHaveLength(0)
  })

  it('blocks inline event handlers', () => {
    const el = new FakeElement() as unknown as HTMLElement
    setTrustedSvg(el, '<svg onload="alert(1)"></svg>')
    expect((el as unknown as FakeElement).children).toHaveLength(0)
  })

  it('blocks javascript: URLs and foreignObject', () => {
    const jsUrl = new FakeElement() as unknown as HTMLElement
    setTrustedSvg(jsUrl, '<svg><a href="javascript:alert(1)">x</a></svg>')
    expect((jsUrl as unknown as FakeElement).children).toHaveLength(0)

    const foreignObject = new FakeElement() as unknown as HTMLElement
    setTrustedSvg(foreignObject, '<svg><foreignObject></foreignObject></svg>')
    expect((foreignObject as unknown as FakeElement).children).toHaveLength(0)
  })

  it('clearChildren empties existing nodes', () => {
    const el = new FakeElement()
    el.appendChild({ tagName: 'span' })
    el.appendChild({ tagName: 'svg' })
    clearChildren(el as unknown as Element)
    expect(el.children).toHaveLength(0)
    expect(el.firstChild).toBeNull()
  })
})
