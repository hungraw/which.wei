import { normalizeHumanAmountInput } from '../utils/parse'

export interface PickerOption<T = string> {
  label: string
  value: T
  icon?: string
  editable?: boolean
  disabled?: boolean
}

interface ScrollSlotConfig<T = string> {
  options: PickerOption<T>[]
  selected: T | null
  className?: string
  displayLabel?: string
  placeholder?: string
  ariaLabel?: string
  onSelect: (value: T, displayLabel?: string) => void
}

export const REVERT_SENTINEL = '__revert__'

const openClosers: Set<(autoSelect?: boolean) => void> = new Set()

export function closeAllPickers() {
  openClosers.forEach(fn => fn(true))
  openClosers.clear()
}

function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:')
}

const PICKER_ICON_SIZE = 18

function makeIcon(url: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = url
  img.className = 'picker-icon'
  img.width = PICKER_ICON_SIZE
  img.height = PICKER_ICON_SIZE
  img.loading = 'lazy'
  img.alt = ''
  return img
}

const ICON_EXTRA_WIDTH = 22
const SLOT_PADDING_WIDTH = 24
const COMMIT_ENABLE_DELAY_MS = 150
const SCROLL_SETTLE_MS = 170
const SCROLL_SETTLE_EDITABLE_MS = 200
const LOCK_FRAMES_INPUT = 2
const LOCK_FRAMES_DISABLED_BOUNCE = 3
const LOCK_FRAMES_TYPING = 4
const CONTAINER_BORDER_OFFSET = 2
const ROW_H = 48 // must match --row-height in CSS
const maxVisible = 4 // viewport rows (gives 1 full + 1/2 peek above/below)
// Padding needed so `scrollTop = idx * ROW_H` centers row idx.
const padTop = (maxVisible * ROW_H - ROW_H) / 2

function isOptionEnabled<T>(opt: PickerOption<T> | undefined): boolean {
  return !!opt && !opt.disabled
}

function findNearestEnabled<T>(fromIdx: number, options: PickerOption<T>[]): number {
  if (isOptionEnabled(options[fromIdx])) return fromIdx
  for (let d = 1; d < options.length; d++) {
    const up = fromIdx - d
    const down = fromIdx + d
    if (up >= 0 && isOptionEnabled(options[up])) return up
    if (down < options.length && isOptionEnabled(options[down])) return down
  }
  return Math.max(0, Math.min(options.length - 1, fromIdx))
}

export function createScrollSlot<T = string>(config: ScrollSlotConfig<T>): {
  el: HTMLElement
  update: (options: PickerOption<T>[], selected: T | null, displayLabel?: string) => void
  setDisabled: (disabled: boolean) => void
  destroy: () => void
} {
  const { className = '', placeholder = '...' } = config
  const ariaLabel = config.ariaLabel ?? placeholder
  let { options, selected, onSelect } = config
  let displayOverride = config.displayLabel ?? null
  let expanded = false
  let scrollCleanup: (() => void) | null = null
  let pickerDisabled = false

  // DOM refs during open
  let container: HTMLElement | null = null
  let borderEl: HTMLElement | null = null
  let scroller: HTMLElement | null = null
  let positionContainer: (() => void) | null = null
  let followRaf = 0

  const root = document.createElement('span')
  root.className = `slot ${className}`
  root.tabIndex = 0
  root.setAttribute('role', 'listbox')
  root.setAttribute('aria-label', ariaLabel)

  function renderInto(el: HTMLElement, opt: PickerOption<T> | undefined, overrideText?: string | null) {
    el.textContent = ''
    if (overrideText) { el.textContent = overrideText; return }
    if (!opt) {
      const ph = document.createElement('span')
      ph.textContent = placeholder
      ph.style.letterSpacing = '0.15em'
      ph.style.opacity = '0.4'
      ph.style.fontWeight = '400'
      ph.style.fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif"
      ph.style.display = 'inline-flex'
      ph.style.alignItems = 'center'
      ph.style.justifyContent = 'center'
      el.appendChild(ph)
      return
    }
    if (opt.icon && isUrl(opt.icon)) {
      // Wrap icon+text in inline-flex for consistent alignment everywhere
      const wrap = document.createElement('span')
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;'
      wrap.appendChild(makeIcon(opt.icon))
      wrap.appendChild(document.createTextNode(opt.label))
      el.appendChild(wrap)
    } else {
      el.textContent = opt.icon ? `${opt.icon} ${opt.label}` : opt.label
    }
  }

  function measureWidth() {
    const measure = document.createElement('span')
    // Match the slot's font to get accurate text width
    const fontFamily = "'SF Mono','Fira Code','JetBrains Mono',monospace"
    measure.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;font-weight:600;font-size:1.15rem;font-family:${fontFamily};`
    document.body.appendChild(measure)
    let maxW = 0
    for (const opt of options) {
      if (opt.editable) continue  // Don't let custom input width affect slot size
      measure.textContent = ''
      if (opt.icon && isUrl(opt.icon)) {
        measure.textContent = opt.label
        maxW = Math.max(maxW, measure.offsetWidth + ICON_EXTRA_WIDTH)
      } else {
        measure.textContent = opt.icon ? `${opt.icon} ${opt.label}` : opt.label
        maxW = Math.max(maxW, measure.offsetWidth)
      }
    }
    measure.textContent = placeholder
    maxW = Math.max(maxW, measure.offsetWidth)
    if (displayOverride) {
      measure.textContent = displayOverride
      maxW = Math.max(maxW, measure.offsetWidth)
    }
    document.body.removeChild(measure)
    // Pure text content width — add padding (0.7rem*2 ≈ 22px) + border (2px)
    if (maxW > 0) root.style.width = `${maxW + SLOT_PADDING_WIDTH}px`
  }

  // Base width set by measureWidth() — restored when no custom value is shown
  let baseWidth = ''

  function render() {
    const current = options.find(o => o.value === selected)
    renderInto(root, current, displayOverride)

    // Auto-size for custom values that exceed the base width
    if (displayOverride && className === 'amount') {
      const measure = document.createElement('span')
      measure.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;font-weight:600;font-size:1.15rem;font-family:'SF Mono','Fira Code','JetBrains Mono',monospace;`
      measure.textContent = displayOverride
      document.body.appendChild(measure)
      const textW = measure.offsetWidth + SLOT_PADDING_WIDTH // padding + border
      document.body.removeChild(measure)
      const currentW = root.offsetWidth
      if (textW > currentW) {
        if (!baseWidth) baseWidth = root.style.width
        root.style.width = `${textW}px`
      }
    } else if (baseWidth) {
      root.style.width = baseWidth
      baseWidth = ''
    }
  }

  function syncBorder() {
    if (!scroller || !borderEl || !container) return
    const scrollTop = scroller.scrollTop
    const viewportH = scroller.offsetHeight

    // Position the green border ring (1 row tall, on center item)
    borderEl.style.top = `${padTop}px`
    borderEl.style.height = `${ROW_H}px`

    // Clip to hide the padding/spacer regions (prevents “extra blank cells”)
    // Items start at y = padTop - scrollTop, end at y = padTop + contentH - scrollTop
    const contentH = options.length * ROW_H
    const clipTopPx = Math.max(0, Math.min(viewportH, padTop - scrollTop))
    const contentEnd = padTop + contentH - scrollTop
    const clipBottomPx = Math.max(0, Math.min(viewportH, viewportH - contentEnd))
    container.style.clipPath = `inset(${clipTopPx}px 0 ${clipBottomPx}px 0 round 8px)`
  }

  function open() {
    if (expanded) return

    // If another picker is open, commit its current selection when switching focus.
    openClosers.forEach(fn => fn(true))
    openClosers.clear()

    expanded = true
    root.classList.add('expanded')
    root.setAttribute('aria-expanded', 'true')

    const selectedIdx = selected !== null ? options.findIndex(o => o.value === selected) : -1
    // Default to editable item (custom input) if nothing selected, or first item if no editable
    const editableIdx = options.findIndex(o => o.editable)
    const scrollToIdx = selectedIdx >= 0 ? selectedIdx : (editableIdx >= 0 ? editableIdx : 0)
    // Always use maxVisible rows for the viewport height (even with fewer options)
    const totalH = maxVisible * ROW_H

    let rafId = 0
    let commitTimer: ReturnType<typeof setTimeout> | null = null
    let allowCommit = false
    let isTyping = false

    // Programmatic lock (small, frame-based) to avoid transient snap-back
    let lockRaf = 0
    let lockFramesRemaining = 0
    let lockTargetScrollTop = 0

    const cancelCommit = () => {
      if (commitTimer) {
        clearTimeout(commitTimer)
        commitTimer = null
      }
    }

    const getCenteredIndex = (): number => {
      if (!scroller) return 0
      const rawIdx = Math.round(scroller.scrollTop / ROW_H)
      return Math.max(0, Math.min(options.length - 1, rawIdx))
    }

    const stopLockScroll = () => {
      cancelAnimationFrame(lockRaf)
      lockFramesRemaining = 0
    }

    const startLockScrollToIndex = (idx: number, frames: number) => {
      if (!scroller) return
      stopLockScroll()
      lockTargetScrollTop = idx * ROW_H
      lockFramesRemaining = frames
      scroller.scrollTop = lockTargetScrollTop
      updateActive(idx)
      syncBorder()

      const step = () => {
        if (!scroller) return
        if (lockFramesRemaining <= 0) return
        lockFramesRemaining--
        scroller.scrollTop = lockTargetScrollTop
        syncBorder()
        lockRaf = requestAnimationFrame(step)
      }
      lockRaf = requestAnimationFrame(step)
    }

    const enterTypingMode = () => {
      if (isTyping) return
      isTyping = true
      cancelCommit()
    }

    const exitTypingMode = () => {
      if (!isTyping) return
      isTyping = false
      stopLockScroll()
    }

    container = document.createElement('div')
    container.className = `picker-container ${className}`.trim()
    container.style.height = `${totalH}px`
    container.style.visibility = 'hidden'  // Hide until initial sync

    borderEl = document.createElement('div')
    borderEl.className = 'picker-border'
    borderEl.style.top = '0px'
    borderEl.style.height = `${totalH}px`

    scroller = document.createElement('div')
    scroller.className = 'picker-scroller'
    scroller.style.height = `${totalH}px`

    // Always add padding for scroll-to-center behavior (top padding only, bottom uses spacer div)
    if (padTop > 0) scroller.style.paddingTop = `${padTop}px`

    function createEditableInput(opt: PickerOption<T>, idx: number): HTMLInputElement {
      const input = document.createElement('input')
      // Use text + inputMode instead of type="number" so users can type '.' or ','
      // and we can normalize to the canonical dot-decimal form.
      input.type = 'text'
      input.inputMode = 'decimal'
      input.spellcheck = false
      input.placeholder = '···'
      input.className = 'picker-input'
      input.setAttribute('aria-label', 'Custom amount')
      if (displayOverride && selected === opt.value) {
        input.value = displayOverride
      }
      input.addEventListener('click', (e) => e.stopPropagation())
      input.addEventListener('focus', () => enterTypingMode())
      input.addEventListener('blur', () => exitTypingMode())
      input.addEventListener('input', () => {
        const cleaned = normalizeHumanAmountInput(input.value)
        input.value = cleaned

        if (cleaned && Number(cleaned) > 0) {
          enterTypingMode()
          displayOverride = cleaned
          selected = opt.value
          onSelect(opt.value, cleaned)
          updateActive(idx)
          // Keep the editable row centered during the initial keystrokes
          startLockScrollToIndex(idx, LOCK_FRAMES_INPUT)
        } else {
          // Empty -> treat as "no selection"
          displayOverride = null
          selected = null
          onSelect(opt.value, REVERT_SENTINEL)
          updateActive(idx)
          startLockScrollToIndex(idx, LOCK_FRAMES_INPUT)
        }
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close()
      })
      return input
    }

    let editableInput: HTMLInputElement | null = null

    for (let i = 0; i < options.length; i++) {
      const opt = options[i]
      const item = document.createElement('div')
      item.className = 'picker-item'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(i === selectedIdx))
      if (i === selectedIdx) item.classList.add('active')

      // Add type-specific classes for styling
      const val = String(opt.value)
      if (val.endsWith('%')) {
        item.classList.add('picker-item-percent')
      } else if (val.startsWith('$')) {
        item.classList.add('picker-item-dollar')
      } else if (opt.editable) {
        item.classList.add('picker-item-custom')
      }

      if (opt.disabled) {
        item.classList.add('disabled')
      }

      if (opt.editable) {
        // Render an input that looks like plain text (no visible box border)
        // so there's no visual jump from slot→picker, but it's immediately editable
        const input = createEditableInput(opt, i)
        input.classList.add('picker-input-inline') // borderless style
        item.appendChild(input)
        // Store ref so we can auto-focus after dropdown opens
        editableInput = input
      } else {
        renderInto(item, opt)
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault() // prevent text selection flash
        if (opt.editable) return
        if (opt.disabled) return
        exitTypingMode()
        selected = opt.value
        displayOverride = null
        onSelect(opt.value)
        close()
      })

      scroller.appendChild(item)
    }

    // Add bottom spacer for reliable scrolling to last items (match top padding)
    if (padTop > 0) {
      const bottomSpacer = document.createElement('div')
      bottomSpacer.className = 'picker-spacer'
      bottomSpacer.style.height = `${padTop}px`
      bottomSpacer.style.flexShrink = '0'
      scroller.appendChild(bottomSpacer)
    }

    // Structure: container > borderEl (visual bg) + scroller (on top, full size)
    container.appendChild(borderEl)
    container.appendChild(scroller)

    // Append to body (not the slot) to avoid being clipped by the slot's pixel-art clip-path
    document.body.appendChild(container)

    // Clicking anywhere on the container that isn't caught by a child's stopPropagation
    // (i.e. not directly on a picker-item) should close the dropdown
    container.addEventListener('click', (e) => {
      e.stopPropagation()
      close(true)
    })

    positionContainer = () => {
      if (!container) return
      const rect = root.getBoundingClientRect()
      container.style.width = `${rect.width + CONTAINER_BORDER_OFFSET}px`
      // Center horizontally on slot
      container.style.left = `${rect.left + rect.width / 2}px`
      // The transform is translate(-50%, -50%), so `top` positions the container's center.
      container.style.top = `${rect.top + rect.height / 2}px`
    }
    positionContainer()

    // Reposition dropdown when page scrolls/resizes so it follows the slot
    const onPageScroll = () => positionContainer?.()
    window.addEventListener('scroll', onPageScroll, { passive: true, capture: true })
    window.addEventListener('resize', onPageScroll, { passive: true })

    // Follow layout transitions (e.g. sentence moving when route cards mount/unmount)
    // Scroll events won't fire for these, so we track the slot rect while expanded.
    let lastRectKey = ''
    const follow = () => {
      if (!expanded || !container) return
      const rect = root.getBoundingClientRect()
      const key = `${rect.left.toFixed(2)}:${rect.top.toFixed(2)}:${rect.width.toFixed(2)}:${rect.height.toFixed(2)}`
      if (key !== lastRectKey) {
        lastRectKey = key
        positionContainer?.()
      }
      followRaf = requestAnimationFrame(follow)
    }
    followRaf = requestAnimationFrame(follow)

    requestAnimationFrame(() => {
      if (!scroller) return
      // Deterministic positioning (index-based)
      scroller.scrollTop = scrollToIdx * ROW_H
      updateActive(scrollToIdx)
      syncBorder()
      // Reveal now that border is positioned correctly
      if (container) {
        container.style.visibility = 'visible'
        // Hide the slot's own bg while dropdown is open (clip-path stays — no flick)
        root.style.background = 'transparent'
      }
    })

    // Scroll handler: always keep clip/border correct; commit selection when user settles
    setTimeout(() => { allowCommit = true }, COMMIT_ENABLE_DELAY_MS)

    const commitCentered = () => {
      if (!scroller) return
      const idx = getCenteredIndex()
      const opt = options[idx]
      if (!opt) return

      if (opt.disabled) return

      if (opt.editable) {
        // Centered on ···
        if (!displayOverride) {
          if (selected !== null) {
            selected = null
            onSelect(opt.value, REVERT_SENTINEL)
          }
        }
        return
      }

      if (opt.value !== selected || displayOverride) {
        selected = opt.value
        displayOverride = null
        onSelect(opt.value)
      }
    }

    const onScroll = () => {
      cancelAnimationFrame(rafId)
      cancelCommit()

      rafId = requestAnimationFrame(() => {
        if (!scroller) return
        syncBorder()

        const idx = getCenteredIndex()
        updateActive(idx)

        // If user tries to scroll onto a disabled row, snap back to nearest enabled.
        const opt = options[idx]
        if (opt && opt.disabled && lockFramesRemaining === 0) {
          const nearest = findNearestEnabled(idx, options)
          if (nearest !== idx) {
            startLockScrollToIndex(nearest, LOCK_FRAMES_DISABLED_BOUNCE)
            return
          }
        }

        if (!allowCommit) return
        if (isTyping) return
        if (lockFramesRemaining > 0) return

        // Use longer debounce when centered on editable "···" to prevent jumping during fast scrolls
        const debounceMs = opt?.editable ? SCROLL_SETTLE_EDITABLE_MS : SCROLL_SETTLE_MS
        commitTimer = setTimeout(() => {
          commitCentered()
        }, debounceMs)
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    // Intercept wheel events to scroll exactly 1 row per tick
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!scroller || lockFramesRemaining > 0) return
      const idx = getCenteredIndex()
      const next = e.deltaY > 0
        ? Math.min(options.length - 1, idx + 1)
        : Math.max(0, idx - 1)
      if (next !== idx) {
        const enabled = findNearestEnabled(next, options)
        scroller.scrollTo({ top: enabled * ROW_H, behavior: 'smooth' })
      }
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })

    // Type-anywhere: jump to ··· and start typing (no jiggle, no snap-back)
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (!expanded) return
      if (!editableInput) return
      if (!/^[0-9.,]$/.test(e.key)) return

      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

      // If already focused, let it flow normally
      if (document.activeElement === editableInput) return
      if (editableIdx < 0) return

      e.preventDefault()
      enterTypingMode()

      // Ensure we’re centered immediately
      startLockScrollToIndex(editableIdx, LOCK_FRAMES_TYPING)

      // Manually inject the key so it never “disappears” due to focus timing
      editableInput.focus({ preventScroll: true })
      editableInput.value = `${editableInput.value ?? ''}${e.key}`
      editableInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.addEventListener('keydown', onDocKeyDown)

    scrollCleanup = () => {
      scroller?.removeEventListener('scroll', onScroll)
      scroller?.removeEventListener('wheel', onWheel)
      window.removeEventListener('scroll', onPageScroll, { capture: true })
      window.removeEventListener('resize', onPageScroll)
      document.removeEventListener('keydown', onDocKeyDown)
      cancelAnimationFrame(rafId)
      cancelCommit()
      isTyping = false
      stopLockScroll()
      cancelAnimationFrame(followRaf)
      followRaf = 0
      positionContainer = null
    }

    openClosers.add(close)
    requestAnimationFrame(() => document.addEventListener('click', outsideClick))
  }

  function updateActive(idx: number) {
    if (!scroller) return
    scroller.querySelectorAll('.picker-item').forEach((item, i) => {
      const isActiveItem = i === idx
      item.classList.toggle('active', isActiveItem)
      item.setAttribute('aria-selected', String(isActiveItem))
    })
  }

  function close(autoSelect: boolean = false) {
    if (!expanded) return
    
    // If closing while centered on an editable item, clear selection (show ···)
    // Use the active item (already tracked by updateActive during scroll)
    if (scroller && className === 'amount') {
      const activeItem = scroller.querySelector('.picker-item.active')
      if (activeItem) {
        const items = Array.from(scroller.querySelectorAll('.picker-item'))
        const activeIdx = items.indexOf(activeItem)
        const activeOpt = options[activeIdx]
        if (activeOpt?.editable && !displayOverride && (selected === null || selected === activeOpt.value)) {
          selected = null
          onSelect(activeOpt.value, REVERT_SENTINEL)
        }
      }
    }
    
    // Auto-select first non-editable option if nothing was selected
    // Skip auto-select for amount picker (user can leave it empty with ···)
    if (autoSelect && selected === null && options.length > 0 && className !== 'amount') {
      const firstSelectable = options.find(o => !o.editable)
      if (firstSelectable) {
        selected = firstSelectable.value
        onSelect(selected)
      }
    }
    
    expanded = false
    root.classList.remove('expanded')
    root.setAttribute('aria-expanded', 'false')
    // Restore slot appearance FIRST, then remove dropdown
    root.style.background = ''
    render()
    scrollCleanup?.()
    scrollCleanup = null
    container?.remove()  // removes from body
    container = null
    borderEl = null
    scroller = null
    openClosers.delete(close)
    document.removeEventListener('click', outsideClick)
  }

  function outsideClick(e: MouseEvent) {
    const target = e.target as Node
    if (!root.contains(target) && !container?.contains(target)) close(true)
  }

  root.addEventListener('click', (e) => {
    e.stopPropagation()
    if (pickerDisabled) return
    if (expanded) close()
    else open()
  })

  root.addEventListener('keydown', (e) => {
    if (pickerDisabled) return
    if (e.key === 'Escape') { close(); return }

    if (!expanded) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        const cur = selected !== null ? options.findIndex(o => o.value === selected) : -1
        for (let i = cur + 1; i < options.length; i++) {
          if (isOptionEnabled(options[i]) && !options[i].editable) {
            selected = options[i].value
            displayOverride = null
            onSelect(selected)
            render()
            break
          }
        }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const cur = selected !== null ? options.findIndex(o => o.value === selected) : options.length
        for (let i = cur - 1; i >= 0; i--) {
          if (isOptionEnabled(options[i]) && !options[i].editable) {
            selected = options[i].value
            displayOverride = null
            onSelect(selected)
            render()
            break
          }
        }
      }
      return
    }

    const currentIdx = selected !== null ? options.findIndex(o => o.value === selected) : -1

    const nextEnabledIndex = (start: number, dir: 1 | -1): number => {
      let i = start
      for (;;) {
        i = i + dir
        if (i < 0 || i >= options.length) return start
        if (!options[i]?.disabled) return i
      }
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      const base = Math.max(-1, currentIdx)
      const next = nextEnabledIndex(base, 1)
      scrollToIndex(next)
      const opt = options[next]
      if (opt && !opt.editable && !opt.disabled) {
        selected = opt.value
        displayOverride = null
        onSelect(selected)
        updateActive(next)
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const base = currentIdx >= 0 ? currentIdx : 0
      const prev = nextEnabledIndex(base, -1)
      scrollToIndex(prev)
      const opt = options[prev]
      if (opt && !opt.editable && !opt.disabled) {
        selected = opt.value
        displayOverride = null
        onSelect(selected)
        updateActive(prev)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      close()
    }
  })

  function scrollToIndex(idx: number) {
    if (!scroller) return
    const targetScroll = idx * ROW_H
    scroller.scrollTo({ top: targetScroll, behavior: 'smooth' })
  }

  render()
  requestAnimationFrame(() => measureWidth())

  return {
    el: root,
    update(newOptions, newSelected, newDisplayLabel) {
      options = newOptions
      selected = newSelected
      displayOverride = newDisplayLabel ?? null
      onSelect = config.onSelect
      render()
      if (expanded) {
        positionContainer?.()
        syncBorder()
      }
      // Don't re-measure width — keep initial width locked to longest option
      // Don't close/reopen while expanded - would reset scroll position
    },
    setDisabled(disabled: boolean) {
      pickerDisabled = disabled
      if (disabled) {
        root.classList.add('picker-disabled')
        close()
      } else {
        root.classList.remove('picker-disabled')
      }
    },
    destroy() {
      close()
      root.remove()
    },
  }
}
