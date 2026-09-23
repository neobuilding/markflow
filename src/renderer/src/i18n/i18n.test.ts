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

  it('localizes the Electron role labels the native menu renders', () => {
    // A bare `{ role: 'undo' }` shows Electron's OWN text, which follows the system locale and
    // therefore stays English after an in-app switch to Chinese. menu.ts now pairs every role
    // with a menuT() label — these are the strings that label must resolve to.
    expect(zhCN['menu.undo']).toBe('撤销')
    expect(zhCN['menu.redo']).toBe('重做')
    expect(zhCN['menu.cut']).toBe('剪切')
    expect(zhCN['menu.copy']).toBe('复制')
    expect(zhCN['menu.paste']).toBe('粘贴')
    expect(zhCN['menu.resetZoom']).toBe('实际大小')
    expect(zhCN['menu.zoomIn']).toBe('放大')
    expect(zhCN['menu.zoomOut']).toBe('缩小')
    expect(zhCN['menu.toggleFullScreen']).toBe('切换全屏')
    expect(zhCN['menu.minimize']).toBe('最小化')
    expect(zhCN['menu.zoom']).toBe('缩放')
    expect(zhCN['menu.quit']).toBe('退出')
    expect(zhCN['menu.closeWindow']).toBe('关闭窗口')
  })

  it('localizes the app-modal confirm fallback button', () => {
    // dialog:confirm used to hardcode 'OK' when the caller passed no okText.
    expect(zhCN['app.ok']).toBe('确定')
    expect(zhCN['app.cancel']).toBe('取消')
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
