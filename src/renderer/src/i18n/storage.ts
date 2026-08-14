// localStorage persistence + language resolution for the renderer-side UI
// language preference. Extracted from i18n/index.ts so the store layer
// (store/ui.ts) can depend on this module directly, cutting the
// i18n/index <-> store/ui circular dependency.
//
// This module is fully self-contained: it does NOT import i18n/index, so the
// cycle is broken at the root (i18n/index imports FROM here, never the reverse).
export type Locale = 'en' | 'zh-CN'

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
