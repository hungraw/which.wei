import { iconX } from './icons'
import { setTrustedSvg } from '../utils/dom'

export interface ModalOptions {
  title: string
  content: HTMLElement
  onClose?: () => void
  closable?: boolean
  modalClass?: string
}

const ANIMATION_DURATION_MS = 200
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

let activeModal: HTMLElement | null = null
const onCloseMap = new WeakMap<HTMLElement, () => void>()
const focusCleanupMap = new WeakMap<HTMLElement, () => void>()

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute('hidden') && el.offsetParent !== null)
}

function installFocusTrap(backdrop: HTMLElement, dialog: HTMLElement, closable: boolean): () => void {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const focusInitial = () => {
    const focusables = getFocusable(dialog)
    const target = focusables[0] ?? dialog
    target.focus()
  }

  requestAnimationFrame(focusInitial)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && closable) {
      e.preventDefault()
      closeModal()
      return
    }

    if (e.key !== 'Tab') return

    const focusables = getFocusable(dialog)
    if (focusables.length === 0) {
      e.preventDefault()
      dialog.focus()
      return
    }

    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null

    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        e.preventDefault()
        last.focus()
      }
      return
    }

    if (active === last || !dialog.contains(active)) {
      e.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', onKeyDown)

  return () => {
    document.removeEventListener('keydown', onKeyDown)
    if (previouslyFocused?.isConnected) {
      previouslyFocused.focus()
    } else if (backdrop.isConnected) {
      backdrop.focus()
    }
  }
}

export function showModal(options: ModalOptions): HTMLElement {
  closeModal()

  const { title, content, onClose, closable = true, modalClass } = options

  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  if (closable) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal()
    })
  }

  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.tabIndex = -1
  if (modalClass) {
    for (const cls of modalClass.split(/\s+/).filter(Boolean)) modal.classList.add(cls)
  }

  const contentContainer = document.createElement('div')
  contentContainer.className = 'modal-content'
  contentContainer.appendChild(content)

  if (title.trim().length > 0) {
    const header = document.createElement('div')
    header.className = 'modal-header'

    const titleEl = document.createElement('h3')
    titleEl.className = 'modal-title'
    titleEl.textContent = title

    if (closable) {
      const closeBtn = document.createElement('button')
      closeBtn.className = 'modal-close'
      setTrustedSvg(closeBtn, iconX(16))
      closeBtn.addEventListener('click', () => closeModal())
      header.append(titleEl, closeBtn)
    } else {
      header.appendChild(titleEl)
    }

    modal.append(header, contentContainer)
  } else {
    modal.append(contentContainer)
  }
  backdrop.appendChild(modal)
  document.body.appendChild(backdrop)

  activeModal = backdrop
  if (onClose) {
    onCloseMap.set(backdrop, onClose)
  }
  focusCleanupMap.set(backdrop, installFocusTrap(backdrop, modal, closable))

  requestAnimationFrame(() => {
    backdrop.classList.add('visible')
  })

  return backdrop
}

export function closeModal(): void {
  if (!activeModal) return

  const backdrop = activeModal
  const onClose = onCloseMap.get(backdrop)
  const cleanupFocus = focusCleanupMap.get(backdrop)

  if (cleanupFocus) {
    cleanupFocus()
    focusCleanupMap.delete(backdrop)
  }

  backdrop.classList.remove('visible')

  setTimeout(() => {
    backdrop.remove()
    if (onClose) onClose()
  }, ANIMATION_DURATION_MS)

  activeModal = null
}
