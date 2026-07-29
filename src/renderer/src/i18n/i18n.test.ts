import { describe, it, expect } from 'vitest'
import { en } from '../../../../shared/i18n/en'
import { zhCN } from '../../../../shared/i18n/zh-CN'
import { normalizeLocale, detectSystemLocale, FALLBACK_LOCALE } from '../i18n'

describe('i18n dictionaries', () => {
  it('zh-CN covers every en key with a non-empty value', () => {
    const enKeys = Object.keys(en).sort()
    const zhKeys = Object.keys(zhCN).sort()
    expect(zhKeys).toEqual(enKeys)
    for (const key of enKeys) {
      const value = zhCN[key as keyof typeof zhCN]
      expect(typeof value).toBe('string')
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })

  it('en is the source of truth (no empty values)', () => {
    for (const value of Object.values(en)) {
      expect(typeof value).toBe('string')
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })

  it('localizes the native file-dialog "All Files" filter label', () => {
    expect(zhCN['menu.filterAllFiles']).toBe('所有文件')
  })
})

describe('locale normalization', () => {
  it('maps Chinese locales to zh-CN (case-insensitive)', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans')).toBe('zh-CN')
    expect(normalizeLocale('ZH-cn')).toBe('zh-CN')
  })

  it('maps any non-Chinese locale to en', () => {
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('ja-JP')).toBe('en')
    expect(normalizeLocale('fr')).toBe('en')
  })

  it('falls back to en for null / undefined / empty', () => {
    expect(normalizeLocale(null)).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale(undefined)).toBe(FALLBACK_LOCALE)
    expect(normalizeLocale('')).toBe(FALLBACK_LOCALE)
  })

  it('detectSystemLocale reads navigator.language', () => {
    const original = navigator.language
    Object.defineProperty(navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })
    expect(detectSystemLocale()).toBe('zh-CN')
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    })
    expect(detectSystemLocale()).toBe('en')
    Object.defineProperty(navigator, 'language', {
      value: original,
      configurable: true,
    })
  })
})
