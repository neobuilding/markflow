import { describe, it, expect } from 'vitest'
import { en, type TranslationKey } from './en'
import { zhCN } from './zh-CN'

// Shared UI translation dictionaries — pure data, validated structurally so a
// missing/extra/mistyped key fails the build via both the type system and these
// runtime assertions (the type check alone doesn't run in `vitest run` for the
// plain-object export without an actual import).

describe('shared/i18n — en dictionary', () => {
  it('exports a non-empty, fully-typed key set', () => {
    const keys = Object.keys(en) as TranslationKey[]
    expect(keys.length).toBeGreaterThan(0)
  })

  it('has no empty or non-string translation values', () => {
    for (const key of Object.keys(en) as TranslationKey[]) {
      expect(typeof en[key]).toBe('string')
      expect(en[key].length).toBeGreaterThan(0)
    }
  })

  it('exposes a TranslationKey type derived from its own keys', () => {
    // The type is `keyof typeof en`; just assert the round-trip at runtime by
    // indexing with a known key.
    expect(en['sidebar.search']).toBe('Search')
  })
})

describe('shared/i18n — zh-CN parity with en', () => {
  it('zh-CN covers exactly the same keys as en', () => {
    const enKeys = new Set(Object.keys(en) as TranslationKey[])
    const zhKeys = new Set(Object.keys(zhCN) as TranslationKey[])
    expect([...zhKeys].sort()).toEqual([...enKeys].sort())
  })

  it('zh-CN has no empty or non-string translation values', () => {
    for (const key of Object.keys(zhCN) as TranslationKey[]) {
      expect(typeof zhCN[key]).toBe('string')
      expect(zhCN[key].length).toBeGreaterThan(0)
    }
  })

  it('zh-CN differs from en for at least one key (real translation, not a copy)', () => {
    // Guards against accidentally shipping the English dictionary as zh-CN.
    expect(zhCN['sidebar.search']).not.toBe(en['sidebar.search'])
  })
})
