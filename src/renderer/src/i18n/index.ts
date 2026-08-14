import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from '../../../../shared/i18n/en'
import { zhCN } from '../../../../shared/i18n/zh-CN'
import type { TranslationKey } from '../../../../shared/i18n/en'

// The localStorage-backed language persistence + resolution layer. Imported here
// so this module can call resolveInitialLanguage() during i18next init, and
// re-exported for external callers. The store layer (store/ui.ts) also imports
// these directly from ./storage to avoid the i18n/index <-> store/ui cycle.
import {
  getStoredLanguage,
  setStoredLanguage,
  resolveInitialLanguage,
  detectSystemLocale,
  normalizeLocale,
  FALLBACK_LOCALE,
  type Locale,
} from './storage'
export {
  getStoredLanguage,
  setStoredLanguage,
  resolveInitialLanguage,
  detectSystemLocale,
  normalizeLocale,
  FALLBACK_LOCALE,
}
export type { Locale }

// Re-export the reactive translator hook. Keeping the hook in its own module
// (useT.ts) means THIS file never imports the store, so the i18n/index <->
// store/ui cycle is fully broken while every existing `import { useT } from '.../i18n'`
// call site keeps working unchanged.
export { useT } from './useT'

// Supported UI locales. English is the canonical fallback.
export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN']

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

// ── i18next setup ─────────────────────────────────────────────────────────
// The renderer uses i18next (+ react-i18next) over the dictionaries in
// ../../shared/i18n, which are the SAME files the Electron main process imports
// (see electron/main/i18n.ts). That keeps the native menu and the in-app UI in
// lockstep. English is the fallback language.
i18next.use(initReactI18next).init({
  lng: resolveInitialLanguage(),
  fallbackLng: FALLBACK_LOCALE,
  resources: {
    en: { translation: en as Record<string, string> },
    'zh-CN': { translation: zhCN as Record<string, string> },
  },
  // Our dictionary keys are flat strings that literally contain dots, so we keep
  // each key as a single literal: disable key/namespace splitting.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
})

// Push a language change into the i18next instance so react-i18next-driven
// components re-render. Called whenever the Zustand store language changes.
export function changeLanguage(locale: Locale): void {
  void i18next.changeLanguage(locale)
}

// Non-reactive translator: reads the current language from the i18next instance.
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return i18next.t(key, params)
}

export { en, zhCN }
export type { TranslationKey }
