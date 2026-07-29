import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { en } from '../../../../shared/i18n/en'
import { zhCN } from '../../../../shared/i18n/zh-CN'
import type { TranslationKey } from '../../../../shared/i18n/en'
import { useUIStore } from '../store/ui'

// Supported UI locales. English is the canonical fallback.
export type Locale = 'en' | 'zh-CN'

export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN']

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

export const FALLBACK_LOCALE: Locale = 'en'

// Maps a BCP 47-ish locale string to one of our supported UI locales.
// Anything that isn't Chinese falls back to English (the required default).
export function normalizeLocale(locale: string | null | undefined): Locale {
  if (!locale) return FALLBACK_LOCALE
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

// Detect the OS / browser locale. Used as the default on first run.
export function detectSystemLocale(): Locale {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return normalizeLocale(navigator.language)
  }
  return FALLBACK_LOCALE
}

// localStorage persistence key (renderer-side preference).
const STORAGE_KEY = 'markflow.language'

export function getStoredLanguage(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'en' || v === 'zh-CN' ? v : null
  } catch {
    return null
  }
}

export function setStoredLanguage(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Ignore storage failures (private mode, etc.)
  }
}

// Resolve the initial UI language: an explicit stored preference wins;
// otherwise fall back to the system locale (which itself falls back to en).
export function resolveInitialLanguage(): Locale {
  return getStoredLanguage() ?? detectSystemLocale()
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

// Reactive translator hook: re-renders the component whenever the language changes.
export function useT(): {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
  language: Locale
  setLanguage: (locale: Locale) => void
} {
  const { t: i18nT } = useTranslation()
  const language = useUIStore((s) => s.language)
  const setLanguage = useUIStore((s) => s.setLanguage)
  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => i18nT(key, params),
    [i18nT],
  )
  return { t, language, setLanguage }
}

export { en, zhCN }
export type { TranslationKey }
