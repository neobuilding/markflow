// Regression guard for the i18next v27 upgrade.
//
// v27 defaults `strictInterpolationChecks` to true, which makes `t`'s options argument REQUIRED
// whenever it is present. A wrapper that forwards `params?: ...` unconditionally produces
// `t(key, undefined)`, which matches neither the single-argument overload nor the
// `[key, options]` overload (TS2345). The wrapper must omit the second argument entirely when
// there are no params. Reverting either wrapper to `i18next.t(key, params)` must make these
// assertions red (and `npm run typecheck` red as well).
import { describe, it, expect, vi, afterEach } from 'vitest'
import i18next from 'i18next'
import { t } from './translate'
import type { TranslationKey } from '../../../../shared/i18n/en'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('non-reactive t() wrapper', () => {
  it('calls i18next.t with exactly one argument when params are absent', () => {
    const spy = vi.spyOn(i18next, 't').mockReturnValue('stub')
    const key = 'sidebar.search' as TranslationKey

    expect(t(key)).toBe('stub')
    expect(spy).toHaveBeenCalledWith(key)
    expect(spy.mock.calls[0]).toHaveLength(1)
  })

  it('forwards params when they are present', () => {
    const spy = vi.spyOn(i18next, 't').mockReturnValue('stub')
    const key = 'status.words' as TranslationKey
    const params = { wordCount: 42 }

    expect(t(key, params)).toBe('stub')
    expect(spy).toHaveBeenCalledWith(key, params)
  })
})
