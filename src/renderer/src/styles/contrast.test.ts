import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'globals.css')
const RAW = readFileSync(cssPath, 'utf-8')

// PLAN C32 U9 — the Tailwind config is the second place a colour could sneak in. Loading the
// real config (instead of grepping it) keeps the guard honest about structure.
const require = createRequire(import.meta.url)
const tailwindConfig = require('../../../../tailwind.config.cjs') as {
  theme?: { extend?: { colors?: Record<string, unknown> } }
  content?: unknown
  darkMode?: unknown
}

/** Extract a `{ ... }` block following a given selector (`:root` or `.dark`). */
function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(selector + ' {')
  if (start < 0) throw new Error(`selector ${selector} not found`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error('unbalanced block')
}

type Tokens = Record<string, string>

/** Pull `--color-*: value;` lines into a map. */
function parseColorTokens(block: string): Tokens {
  const map: Tokens = {}
  const re = /--color-([a-z-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) {
    map[m[1]] = m[2].trim()
  }
  return map
}

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

/** Resolve a token value to an opaque RGB. Handles nested `var(--x)`, hex, and
 *  `color-mix(in srgb, var(--x) P%, transparent)` (used by --color-danger-tint). */
function resolve(value: string, tokens: Tokens, seen = new Set<string>()): RGB {
  const v = value.trim()
  if (v.startsWith('var(')) {
    const name = v
      .slice(4, v.indexOf(')'))
      .trim()
      .replace(/^--color-/, '')
    if (seen.has(name)) throw new Error('cyclic var: ' + name)
    seen.add(name)
    if (!(name in tokens)) throw new Error('unknown token --color-' + name)
    return resolve(tokens[name], tokens, seen)
  }
  if (v.startsWith('color-mix')) {
    const m = v.match(
      /color-mix\(in srgb,\s*var\(--color-([a-z-]+)\)\s+(\d+(?:\.\d+)?)%,\s*transparent\)/,
    )
    if (!m) throw new Error('unsupported color-mix: ' + v)
    const base = resolve('var(--color-' + m[1] + ')', tokens, seen)
    const p = parseFloat(m[2]) / 100
    // `color-mix(... 12%, transparent)` over a surface = solid base at 12% alpha.
    return [base[0] * p, base[1] * p, base[2] * p]
  }
  if (v.startsWith('#')) return hexToRgb(v)
  throw new Error('unsupported color value: ' + v)
}

/** Composite `fg` (with alpha = 1 - already applied) over `bg` — used for tint composites. */
function composite(fg: RGB, fgAlpha: number, bg: RGB): RGB {
  return [
    fg[0] * fgAlpha + bg[0] * (1 - fgAlpha),
    fg[1] * fgAlpha + bg[1] * (1 - fgAlpha),
    fg[2] * fgAlpha + bg[2] * (1 - fgAlpha),
  ]
}

function relLuminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: RGB, b: RGB): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const THEMES = {
  light: parseColorTokens(extractBlock(RAW, ':root')),
  dark: parseColorTokens(extractBlock(RAW, '.dark')),
} as const

type ThemeName = keyof typeof THEMES
const BACKGROUNDS = ['bg', 'surface', 'surface-overlay', 'accent-muted'] as const

/** Resolve a token that may be a tint composite: `--color-danger-tint` resolves to
 *  danger at 12% over the given surface, matching how the menu hover fill composites. */
function resolveOver(token: string, theme: ThemeName, bgToken: string): RGB {
  const tokens = THEMES[theme]
  if (token === 'danger-tint') {
    const danger = resolve('var(--color-danger)', tokens)
    const bg = resolve('var(--color-' + bgToken + ')', tokens)
    return composite(danger, 0.12, bg)
  }
  return resolve('var(--color-' + token + ')', tokens)
}

describe('C25 — palette contrast guard (ADR-0024 §1.1)', () => {
  const themes: ThemeName[] = ['light', 'dark']

  it('text tokens clear WCAG 1.4.3 (≥4.5:1) on every surface', () => {
    const textTokens = ['text-primary', 'text-secondary', 'text-tertiary']
    for (const theme of themes) {
      for (const t of textTokens) {
        const fg = resolve('var(--color-' + t + ')', THEMES[theme])
        for (const bg of BACKGROUNDS) {
          const bgRgb = resolve('var(--color-' + bg + ')', THEMES[theme])
          const ratio = contrast(fg, bgRgb)
          expect(ratio, `${theme} ${t} on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('semantic colours clear WCAG 1.4.11 as indicators (≥3:1) on every surface', () => {
    const indicators = ['accent', 'danger', 'success', 'warning']
    for (const theme of themes) {
      for (const ind of indicators) {
        const fg = resolve('var(--color-' + ind + ')', THEMES[theme])
        for (const bg of BACKGROUNDS) {
          const bgRgb = resolve('var(--color-' + bg + ')', THEMES[theme])
          const ratio = contrast(fg, bgRgb)
          expect(ratio, `${theme} ${ind} indicator on ${bg}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('--color-danger-text clears 1.4.3 (≥4.5:1) on every surface AND on its hover fill', () => {
    for (const theme of themes) {
      const fg = resolve('var(--color-danger-text)', THEMES[theme])
      for (const bg of BACKGROUNDS) {
        const onSurface = contrast(fg, resolve('var(--color-' + bg + ')', THEMES[theme]))
        expect(onSurface, `${theme} danger-text on ${bg}`).toBeGreaterThanOrEqual(4.5)
        // hover fill = danger tint (danger 12% over the surface)
        const onTint = contrast(fg, resolveOver('danger-tint', theme, bg))
        expect(onTint, `${theme} danger-text on ${bg} hover fill`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('focus-ring accent clears 1.4.11 (≥3:1) on bg / surface / surface-overlay', () => {
    for (const theme of themes) {
      const ring = resolve('var(--color-accent)', THEMES[theme])
      for (const bg of ['bg', 'surface', 'surface-overlay'] as const) {
        const ratio = contrast(ring, resolve('var(--color-' + bg + ')', THEMES[theme]))
        expect(ratio, `${theme} focus-ring on ${bg}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it(':root and .dark declare the same token set (no cross-theme drift)', () => {
    const light = Object.keys(THEMES.light).sort()
    const dark = Object.keys(THEMES.dark).sort()
    expect(dark).toEqual(light)
  })

  describe('negative tests — the floor must actually fail when violated', () => {
    it('light text-secondary at #94a3b8 (a diagram slate) fails 4.5:1', () => {
      const mutated = RAW.replace(/(--color-text-secondary\s*:\s*)#536176/, '$1#94a3b8')
      const lt = parseColorTokens(extractBlock(mutated, ':root'))
      const fg = resolve('var(--color-text-secondary)', lt)
      const ratio = contrast(fg, resolve('var(--color-bg)', lt))
      expect(ratio).toBeLessThan(4.5)
    })

    it('light text-tertiary reverted to #9b9b9b fails 4.5:1', () => {
      const mutated = RAW.replace(/(--color-text-tertiary\s*:\s*)#536176/, '$1#9b9b9b')
      const lt = parseColorTokens(extractBlock(mutated, ':root'))
      const fg = resolve('var(--color-text-tertiary)', lt)
      const ratio = contrast(fg, resolve('var(--color-bg)', lt))
      expect(ratio).toBeLessThan(4.5)
    })
  })
})

// PLAN C32 U9 / ADR-0024 §1.5 (Tailwind v4.3.3) — the config must REFERENCE the CSS variables,
// never restate them. A hex in the config is a second source of truth, and it is exactly the
// drift that produced the stale `#9b9b9b` this whole guard exists to prevent.
describe('tailwind.config is not a second source of truth (C32 U9)', () => {
  const colors = tailwindConfig.theme?.extend?.colors ?? {}

  function collectStrings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out)
    }
    return out
  }

  it('declares no colour hex anywhere under theme.extend.colors', () => {
    const hexes = collectStrings(colors).filter((v) => /#[0-9a-f]{3,8}\b/i.test(v))
    expect(hexes, `hardcoded colour(s) in tailwind.config.cjs: ${hexes.join(', ')}`).toEqual([])
  })

  it('points accent.DEFAULT at the CSS variable', () => {
    const accent = colors.accent as { DEFAULT?: unknown } | undefined
    expect(accent?.DEFAULT).toBe('var(--color-accent)')
  })

  it('carries no Tailwind v3 residue (content / darkMode are no-ops in v4)', () => {
    // `globals.css` uses `@source` and `@custom-variant dark` instead; keeping the v3 keys here
    // would be a silent second source of truth (PLAN C22 F4 / C27).
    expect(tailwindConfig.content).toBeUndefined()
    expect(tailwindConfig.darkMode).toBeUndefined()
  })
})
