// Integration test for App.tsx's theme effect (ADR-0028).
//
// The effect owns two things:
//   1. it resolves the store's `theme` choice into the `dark` class on <html>, and
//   2. while the choice is `system`, it FOLLOWS the OS preference live (no restart).
//
// The live-follow part is the interesting one: it needs a media query the test can drive, and
// jsdom does not implement `window.matchMedia` at all. The stub below installs one that reports a
// controllable preference and notifies its listeners, exactly like a real OS theme switch.
//
// The `matchMedia` stub is installed PER TEST (the same pattern as
// `components/preview/MarkdownPreview.test.tsx` and `lib/export.test.ts`) and restored afterwards,
// so no suite can inherit another suite's fake OS preference.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { useUIStore } from './store/ui'
import { queryClient } from './lib/queryClient'

type ChangeListener = (event: MediaQueryListEvent) => void

/**
 * Install a controllable `window.matchMedia` stub.
 *
 * The returned object exposes the OS preference (`setDark`) and notifies every listener that
 * registered through `addEventListener('change', …)` — the mechanism App's theme effect uses.
 */
function installMatchMedia(initialDark: boolean): {
  setDark: (value: boolean) => void
  restore: () => void
} {
  let dark = initialDark
  const listeners = new Set<ChangeListener>()
  const mql = {
    media: '(prefers-color-scheme: dark)',
    get matches() {
      return dark
    },
    onchange: null,
    addEventListener: (_type: string, cb: ChangeListener) => {
      listeners.add(cb)
    },
    removeEventListener: (_type: string, cb: ChangeListener) => {
      listeners.delete(cb)
    },
    dispatchEvent: () => true,
    addListener: (cb: ChangeListener) => listeners.add(cb),
    removeListener: (cb: ChangeListener) => listeners.delete(cb),
  }
  const original = window.matchMedia
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia
  return {
    setDark: (value: boolean) => {
      dark = value
      const event = { matches: value, media: mql.media } as MediaQueryListEvent
      listeners.forEach((cb) => cb(event))
    },
    restore: () => {
      if (original) window.matchMedia = original
      else delete (window as unknown as { matchMedia?: unknown }).matchMedia
    },
  }
}

/** Mount the app shell with the minimal `window.api` surface App subscribes to on mount. */
function mountApp() {
  const noop = () => () => {}
  const api = {
    onFileChanged: noop,
    onOpenPaths: noop,
    onMenuEvent: noop,
    onAppRequestQuit: noop,
    onFolderChanged: noop,
    onDocumentRefresh: noop,
    documents: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
  }
  ;(window as unknown as { api: unknown }).api = api
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
}

const isDark = (): boolean => document.documentElement.classList.contains('dark')

describe('App — theme resolution (ADR-0028)', () => {
  beforeEach(() => {
    // The <html> class is global state that survives unmounting, so each test starts clean.
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('applies the OS preference when the choice is "system"', () => {
    const media = installMatchMedia(true)
    try {
      useUIStore.getState().setTheme('system')
      mountApp()
      expect(isDark()).toBe(true)
    } finally {
      media.restore()
    }
  })

  it('follows the OS preference live while the choice is "system" (no restart)', () => {
    const media = installMatchMedia(false)
    try {
      useUIStore.getState().setTheme('system')
      mountApp()
      expect(isDark()).toBe(false)

      // The OS flips to dark: the effect's `change` listener re-applies the class immediately.
      media.setDark(true)
      expect(isDark()).toBe(true)

      // …and back again.
      media.setDark(false)
      expect(isDark()).toBe(false)
    } finally {
      media.restore()
    }
  })

  it('stops following the OS once the choice is explicit', () => {
    const media = installMatchMedia(false)
    try {
      useUIStore.getState().setTheme('dark')
      mountApp()
      // The explicit choice wins over the (light) OS preference.
      expect(isDark()).toBe(true)

      // No listener is installed for an explicit choice, so an OS flip changes nothing.
      media.setDark(false)
      expect(isDark()).toBe(true)
    } finally {
      media.restore()
    }
  })

  it('unsubscribes from the OS preference when the app unmounts', () => {
    const media = installMatchMedia(false)
    try {
      useUIStore.getState().setTheme('system')
      const view = mountApp()
      view.unmount()

      // After unmount the listener is gone, so the class no longer tracks the OS.
      media.setDark(true)
      expect(isDark()).toBe(false)
    } finally {
      media.restore()
    }
  })

  it('degrades to the light theme when the host has no matchMedia at all', () => {
    // jsdom does not implement `window.matchMedia`; the effect must not throw and must fall back
    // to the light theme (the same fallback `lib/export.ts` uses).
    const original = window.matchMedia
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
    try {
      useUIStore.getState().setTheme('system')
      expect(() => mountApp()).not.toThrow()
      expect(isDark()).toBe(false)
    } finally {
      window.matchMedia = original
    }
  })
})
