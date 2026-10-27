import i18next from 'i18next'
import type { TranslationKey } from '../../../../shared/i18n/en'

// Non-reactive translator, split out of `i18n/index.ts` so non-React modules (notably the UI
// store) can translate WITHOUT pulling in `useT` — which imports the store, which would close an
// i18n/index -> useT -> store/ui -> i18n/index cycle.
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return i18next.t(key, params)
}
