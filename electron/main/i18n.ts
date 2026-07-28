import i18next from 'i18next'
import { app } from 'electron'
import { en } from '../../shared/i18n/en'
import { zhCN } from '../../shared/i18n/zh-CN'
import type { TranslationKey } from '../../shared/i18n/en'

// UI locale used by the native menu / dialogs in the main process.
export type MenuLocale = 'en' | 'zh-CN'

let currentLocale: MenuLocale = 'en'

// Detect the OS locale for the default menu language on first run.
export function detectSystemLocale(): MenuLocale {
  const l = (app.getLocale() || '').toLowerCase()
  return l.startsWith('zh') ? 'zh-CN' : 'en'
}

export function getCurrentLocale(): MenuLocale {
  return currentLocale
}

// Initialize the main-process i18next instance over the SAME dictionaries the
// renderer uses, so the native menu never drifts from the in-app UI.
export function initMenuI18n(): void {
  currentLocale = detectSystemLocale()
  i18next.init({
    lng: currentLocale,
    fallbackLng: 'en',
    resources: {
      en: { translation: en as Record<string, string> },
      'zh-CN': { translation: zhCN as Record<string, string> },
    },
    // Flat dot-literal keys, no key/namespace splitting.
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
  })
}

// Command-style translator for the native menu/dialogs. We pass `lng` explicitly
// so the lookup is correct even before an async changeLanguage() settles.
// `key` is typed as TranslationKey so menu keys are checked at compile time.
export function menuT(key: TranslationKey): string {
  return i18next.t(key, { lng: currentLocale })
}

// Apply a language change: update the active locale and (async) the instance.
export function setMenuLanguage(locale: MenuLocale): void {
  currentLocale = locale
  void i18next.changeLanguage(locale)
}
