import i18next from 'i18next'
import type { TFunction } from 'i18next'
import type { TranslationKey } from '../../../../shared/i18n/en'

/**
 * Call `t` with the options argument OMITTED when there are no params.
 *
 * i18next v27 defaults `strictInterpolationChecks` to true, which makes `t`'s options argument
 * required whenever it is present: forwarding `undefined` matches neither the single-argument
 * overload nor the `[key, options]` one (TS2345).
 *
 * Both translators in this folder need that rule — the non-reactive wrapper below and the
 * reactive hook in `./useT` — so it lives in one place. Typed against i18next's own
 * `TFunction`, which is exactly what react-i18next returns from `useTranslation()`, so the hook
 * reuses this without a cast.
 */
export function translateWith(
  t: TFunction,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return params ? t(key, params) : t(key)
}

// Non-reactive translator, split out of `i18n/index.ts` so non-React modules (notably the UI
// store) can translate WITHOUT pulling in `useT` — which imports the store, which would close an
// i18n/index -> useT -> store/ui -> i18n/index cycle.
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translateWith(i18next.t, key, params)
}
