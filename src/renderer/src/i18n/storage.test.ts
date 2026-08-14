import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getStoredLanguage,
  setStoredLanguage,
  resolveInitialLanguage,
  normalizeLocale,
  FALLBACK_LOCALE,
} from './storage'

describe('storage — getStoredLanguage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the stored locale when it is a valid supported value', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('zh-CN')
    expect(getStoredLanguage()).toBe('zh-CN')
  })

  it('returns null for an unsupported / unknown stored value', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('fr-FR')
    expect(getStoredLanguage()).toBeNull()
  })

  it('returns null when localStorage access throws (private mode, etc.)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(getStoredLanguage()).toBeNull()
  })
})

describe('storage — setStoredLanguage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the locale to localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    setStoredLanguage('en')
    expect(spy).toHaveBeenCalledWith('markflow.language', 'en')
  })

  it('swallows storage failures without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    expect(() => setStoredLanguage('zh-CN')).not.toThrow()
  })
})

describe('storage — resolveInitialLanguage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers a stored preference over the system locale', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('zh-CN')
    const original = navigator.language
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    })
    expect(resolveInitialLanguage()).toBe('zh-CN')
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })

  it('falls back to the system locale when nothing is stored', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    const original = navigator.language
    Object.defineProperty(navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })
    expect(resolveInitialLanguage()).toBe('zh-CN')
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })

  it('falls back to the system locale when storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const original = navigator.language
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    })
    // getStoredLanguage() returns null after the throw, so resolveInitialLanguage
    // delegates to detectSystemLocale(); an English system locale maps to the
    // 'en' default (FALLBACK_LOCALE).
    expect(resolveInitialLanguage()).toBe(FALLBACK_LOCALE)
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })
})

describe('storage — normalizeLocale', () => {
  it('normalizes both supported locales', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN')
    expect(normalizeLocale('en')).toBe('en')
  })

  it('falls back to en for falsy / non-matching locales', () => {
    expect(normalizeLocale(null)).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale(undefined)).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale('')).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale('fr-FR')).toBe('en')
  })
})
