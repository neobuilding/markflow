import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useT } from './useT'
import { useUIStore } from '../store/ui'

// Captured t() call arguments. vi.mock factories are hoisted above top-level declarations, so
// the array must live in vi.hoisted() to exist before the factory runs.
const { tCalls } = vi.hoisted(() => ({ tCalls: [] as unknown[][] }))

// Stub react-i18next's useTranslation so we isolate useT's store-bridging logic
// (it must read language + setLanguage from the Zustand store and forward t()).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (...args: unknown[]) => {
      tCalls.push(args)
      const [key, params] = args
      return `t:${String(key)}:${JSON.stringify(params ?? {})}`
    },
    i18n: {},
  }),
}))

describe('useT', () => {
  beforeEach(() => {
    useUIStore.getState().setLanguage('en')
    tCalls.length = 0
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

  // i18next v27 defaults `strictInterpolationChecks` to true, which makes t()'s options argument
  // required whenever it is present: `t(key, undefined)` matches neither overload (TS2345).
  // The hook therefore omits the argument entirely when there are no params. Reverting it to
  // `i18nT(key, params)` makes the length assertion below red.
  it('omits the options argument when there are no params', () => {
    const { result } = renderHook(() => useT())
    result.current.t('app.title' as never)
    expect(tCalls[0]).toHaveLength(1)
  })

  it('forwards the options argument when params are present', () => {
    const { result } = renderHook(() => useT())
    result.current.t('status.words' as never, { wordCount: 3 })
    expect(tCalls[0]).toHaveLength(2)
  })
})
