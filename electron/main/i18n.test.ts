import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ locale: 'en-US' }))

vi.mock('electron', () => ({
  app: {
    getLocale: () => h.locale,
  },
}))

const i18n = await import('./i18n')

beforeEach(async () => {
  h.locale = 'en-US'
  // Initialize i18next so changeLanguage / menuT work in tests.
  await i18n.initMenuI18n()
  i18n.setMenuLanguage('en')
})

describe('main-process i18n', () => {
  it('detects a Chinese system locale', () => {
    h.locale = 'zh-CN'
    expect(i18n.detectSystemLocale()).toBe('zh-CN')
  })

  it('detects a non-Chinese system locale as English', () => {
    h.locale = 'en-US'
    expect(i18n.detectSystemLocale()).toBe('en')
  })

  it('falls back to English when the system locale is empty', () => {
    h.locale = ''
    expect(i18n.detectSystemLocale()).toBe('en')
  })

  it('tracks the current menu locale', () => {
    expect(i18n.getCurrentLocale()).toBe('en')
    i18n.setMenuLanguage('zh-CN')
    expect(i18n.getCurrentLocale()).toBe('zh-CN')
  })

  it('translates via menuT', () => {
    expect(i18n.menuT('menu.file')).toBe('File')
    i18n.setMenuLanguage('zh-CN')
    expect(i18n.menuT('menu.file')).toBe('文件')
  })
})
