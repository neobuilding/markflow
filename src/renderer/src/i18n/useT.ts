import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../store/ui'
import type { TranslationKey } from '../../../../shared/i18n/en'
import type { Locale } from './storage'
// ./translate holds no store import, so reaching for it here cannot recreate the
// i18n/index <-> useT cycle this module exists to break.
import { translateWith } from './translate'

// Reactive translator hook: re-renders the component whenever the language changes.
// Kept in its own module so i18n/index.ts does NOT need to import the store (that
// import was the source of the i18n/index <-> store/ui circular dependency). The
// store has a legitimate reason to depend on i18n (via ./storage), but i18n/index
// must stay store-free; this hook is the only place that bridges the two.
// NOTE: this file must NOT import ./index (even as a type) doing so would recreate
// the i18n/index <-> useT cycle. Locale is taken from ./storage instead.
export function useT(): {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
  language: Locale
  setLanguage: (locale: Locale) => void
} {
  const { t: i18nT } = useTranslation()
  const language = useUIStore((s) => s.language)
  const setLanguage = useUIStore((s) => s.setLanguage)
  const t = useCallback(
    // This hook must stay reactive (react-i18next re-renders on a language change), so it keeps
    // react-i18next's own `t` rather than the non-reactive wrapper in ./translate.ts. The
    // "omit the options argument when empty" rule is shared through translateWith().
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translateWith(i18nT, key, params),
    [i18nT],
  )
  return { t, language, setLanguage }
}
