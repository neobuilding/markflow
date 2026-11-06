import { describe, it, expect } from 'vitest'
import { en, type TranslationKey } from './en'
import { zhCN } from './zh-CN'

// Shared UI translation dictionaries pure data, validated structurally so a
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

describe('shared/i18n — find option scopes (C20 补 ⑧)', () => {
  it('states the scope on both find-option families', () => {
    // The sidebar Search view searches the WORKSPACE; the in-document find widget searches the
    // CURRENT document. The toggles are named alike but do different things, and they do NOT
    // link up — so each tooltip has to say which scope it applies to (ADR-0024 §10 trade-off 45).
    expect(en['search.matchCase']).not.toBe(en['find.toggle.case'])
    expect(en['search.matchCase']).toContain('workspace')
    expect(en['find.toggle.case']).toContain('document')
    expect(zhCN['search.matchCase']).toContain('工作区')
    expect(zhCN['find.toggle.case']).toContain('文档')
    // …for every option of both families, not just the first one. (The regex key differs
    // between the two families: `search.regexp` vs `find.toggle.regex`.)
    for (const [searchKey, findKey] of [
      ['search.wholeWord', 'find.toggle.wholeWord'],
      ['search.regexp', 'find.toggle.regex'],
    ] as const) {
      expect(en[searchKey]).toContain('workspace')
      expect(en[findKey]).toContain('document')
      expect(zhCN[searchKey]).toContain('工作区')
      expect(zhCN[findKey]).toContain('文档')
    }
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

  it('leaves no key untranslated outside the intentional pass-throughs', () => {
    // The only keys whose zh-CN value is deliberately identical to English: the two language
    // names in the Language menu (a language switcher must show each language's OWN name) and
    // the two file-format filter names. Anything else that matches English means a key was
    // copied over instead of written in Chinese — e.g. a menu entry shipping English text.
    const intentionalPassThroughs = new Set<TranslationKey>([
      'menu.english',
      'menu.chinese',
      'menu.filterMarkdown',
      'menu.filterHtml',
      // Visual glyphs on the find toggle group (Aa / ab / .* / AB) are language-neutral.
      'find.toggle.caseShort',
      'find.toggle.wholeWordShort',
      'find.toggle.regexShort',
      'find.toggle.preserveCaseShort',
    ])
    const untranslated = (Object.keys(en) as TranslationKey[]).filter(
      (key) => en[key] === zhCN[key] && !intentionalPassThroughs.has(key),
    )
    expect(untranslated).toEqual([])
  })
})
