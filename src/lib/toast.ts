// Simple toast notification system — no external dependency
// Shows a temporary message at the bottom-right of the screen

let toastContainer: HTMLDivElement | null = null

function getContainer(): HTMLDivElement {
  if (toastContainer && document.body.contains(toastContainer)) return toastContainer

  toastContainer = document.createElement('div')
  toastContainer.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `
  document.body.appendChild(toastContainer)
  return toastContainer
}

type ToastType = 'success' | 'error' | 'info'

function showToast(type: ToastType, message: string, description?: string) {
  const container = getContainer()

  const colors: Record<ToastType, { bg: string; border: string; text: string }> = {
    success: { bg: '#16261c', border: '#22c55e', text: '#86efac' },
    error: { bg: '#2a1212', border: '#ef4444', text: '#fca5a5' },
    info: { bg: '#0f1a2a', border: '#3b82f6', text: '#93c5fd' },
  }

  const c = colors[type]
  const toast = document.createElement('div')
  toast.style.cssText = `
    background: ${c.bg};
    border: 1px solid ${c.border};
    border-left: 3px solid ${c.border};
    border-radius: 8px;
    padding: 12px 16px;
    min-width: 280px;
    max-width: 400px;
    color: ${c.text};
    font-size: 13px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    pointer-events: auto;
    opacity: 0;
    transform: translateX(100%);
    transition: opacity 0.2s, transform 0.2s;
  `

  const title = document.createElement('div')
  title.style.fontWeight = '600'
  title.textContent = message
  toast.appendChild(title)

  if (description) {
    const desc = document.createElement('div')
    desc.style.cssText = 'margin-top: 4px; font-size: 11px; opacity: 0.8; white-space: pre-line;'
    desc.textContent = description
    toast.appendChild(desc)
  }

  container.appendChild(toast)

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1'
    toast.style.transform = 'translateX(0)'
  })

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transform = 'translateX(100%)'
    setTimeout(() => toast.remove(), 200)
  }, 4000)
}

export const toast = {
  success: (message: string, opts?: { description?: string }) =>
    showToast('success', message, opts?.description),
  error: (message: string, opts?: { description?: string }) =>
    showToast('error', message, opts?.description),
  info: (message: string, opts?: { description?: string }) =>
    showToast('info', message, opts?.description),
  message: (message: string) => showToast('info', message),
}

// Also export as default for convenience
export default toast
