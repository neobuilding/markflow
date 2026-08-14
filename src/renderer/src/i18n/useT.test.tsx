import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useT } from './useT'
import { useUIStore } from '../store/ui'

// Stub react-i18next's useTranslation so we isolate useT's store-bridging logic
// (it must read language + setLanguage from the Zustand store and forward t()).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      `t:${key}:${JSON.stringify(params ?? {})}`,
    i18n: {},
  }),
}))

describe('useT', () => {
  beforeEach(() => {
    useUIStore.getState().setLanguage('en')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes the store language and setLanguage', () => {
    const { result } = renderHook(() => useT())
    expect(result.current.language).toBe('en')
    expect(typeof result.current.setLanguage).toBe('function')
  })

  it('reflects language changes from the store reactively', () => {
    const { result } = renderHook(() => useT())
    act(() => {
      useUIStore.getState().setLanguage('zh-CN')
    })
    expect(result.current.language).toBe('zh-CN')
  })

  it('forwards t() calls to react-i18next with params', () => {
    const { result } = renderHook(() => useT())
    const out = result.current.t('app.title' as never, { a: 1 })
    expect(out).toContain('app.title')
  })
})
