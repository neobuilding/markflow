import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  normalizeLocale,
  detectSystemLocale,
  getStoredLanguage,
  setStoredLanguage,
  resolveInitialLanguage,
  changeLanguage,
  t,
  useT,
  FALLBACK_LOCALE,
} from './index'
import { useUIStore } from '../store/ui'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(factory: () => T) {
  const result = { current: undefined as unknown as T }
  function Wrapper() {
    result.current = factory()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<Wrapper />)
  })
  return { result, unmount: () => act(() => root.unmount()) }
}

describe('i18n — normalizeLocale', () => {
  it('maps zh* to zh-CN case-insensitively', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans')).toBe('zh-CN')
    expect(normalizeLocale('ZH-cn')).toBe('zh-CN')
  })
  it('maps any non-Chinese locale to en', () => {
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('ja-JP')).toBe('en')
    expect(normalizeLocale('fr')).toBe('en')
  })
  it('falls back to en for null/undefined/empty', () => {
    expect(normalizeLocale(null)).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale(undefined)).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale('')).toBe(FALLBACK_LOCALE)
  })
})

describe('i18n — stored language persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('getStoredLanguage returns null when nothing stored', () => {
    expect(getStoredLanguage()).toBeNull()
  })

  it('setStoredLanguage persists a supported locale and getStoredLanguage reads it back', () => {
    setStoredLanguage('zh-CN')
    expect(getStoredLanguage()).toBe('zh-CN')
    setStoredLanguage('en')
    expect(getStoredLanguage()).toBe('en')
  })

  it('getStoredLanguage ignores invalid stored values', () => {
    localStorage.setItem('markflow.language', 'klingon')
    expect(getStoredLanguage()).toBeNull()
  })

  it('resolveInitialLanguage prefers a stored preference over the system locale', () => {
    localStorage.setItem('markflow.language', 'zh-CN')
    const original = navigator.language
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    expect(resolveInitialLanguage()).toBe('zh-CN')
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })

  it('resolveInitialLanguage falls back to the detected system locale', () => {
    const original = navigator.language
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    expect(resolveInitialLanguage()).toBe('zh-CN')
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })
})

describe('i18n — detectSystemLocale', () => {
  it('reads navigator.language', () => {
    const original = navigator.language
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    expect(detectSystemLocale()).toBe('en')
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    expect(detectSystemLocale()).toBe('zh-CN')
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })

  it('falls back to en when navigator is unavailable', () => {
    const original = globalThis.navigator
    // @ts-expect-error - simulating a non-browser environment
    delete globalThis.navigator
    try {
      expect(detectSystemLocale()).toBe('en')
    } finally {
      globalThis.navigator = original
    }
  })
})

describe('i18n — translation access', () => {
  it('t() resolves a known en key', () => {
    changeLanguage('en')
    expect(t('sidebar.search')).toBe('Search')
  })
  it('t() resolves a zh-CN key after switching language', () => {
    changeLanguage('zh-CN')
    expect(t('sidebar.search')).toBe('搜索')
    changeLanguage('en')
  })
  it('t() interpolates params', () => {
    changeLanguage('en')
    expect(t('status.words', { wordCount: 42 })).toBe('42 words')
  })
})

describe('i18n — useT reactive hook', () => {
  it('exposes a translator bound to the current store language and setLanguage', async () => {
    act(() => useUIStore.getState().setLanguage('en'))
    const { result } = renderHook(() => useT())
    expect(result.current.language).toBe('en')
    expect(result.current.t('sidebar.search')).toBe('Search')
    // setLanguage only updates the store; the i18next instance switches via changeLanguage
    // (wired in the app). Drive both so the reactive translator re-renders in zh-CN.
    act(() => {
      result.current.setLanguage('zh-CN')
      changeLanguage('zh-CN')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(useUIStore.getState().language).toBe('zh-CN')
    expect(result.current.language).toBe('zh-CN')
    expect(result.current.t('sidebar.search')).toBe('搜索')
    act(() => {
      result.current.setLanguage('en')
      changeLanguage('en')
    })
  })
})
