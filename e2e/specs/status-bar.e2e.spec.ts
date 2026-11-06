// Status-bar contrast e2e (PLAN C32 E10)
// The status bar is where the palette is under the most pressure: a muted label, a coloured
// status glyph and a state-bearing border all share one thin row. The unit test (C32 U6/U7)
// checks the CLASS names; this spec checks the colours the engine actually paints.
//
// Roles (ADR-0024 §1.1):
//   - the status TEXT is ordinary text → WCAG 1.4.3, ≥ 4.5:1;
//   - the ● / ✓ GLYPH and the low-confidence border are INDICATORS → WCAG 1.4.11, ≥ 3:1.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

interface Measured {
  fg: string
  bg: string
  ratio: number
}

/** Contrast of an element's painted colour against its effective (first opaque) background. */
async function measureContrast(page: Page, selector: string): Promise<Measured | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const parse = (c: string): [number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0]
      const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
      return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
    }
    const lum = ([r, g, b]: [number, number, number]) => {
      const f = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    let bg = 'rgb(255, 255, 255)'
    let node: HTMLElement | null = el
    while (node) {
      const c = getComputedStyle(node).backgroundColor
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c
        break
      }
      node = node.parentElement
    }
    const fg = getComputedStyle(el).color
    const l1 = lum(parse(fg))
    const l2 = lum(parse(bg))
    return { fg, bg, ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
  }, selector)
}

/**
 * Contrast of a CSS custom property (resolved by the engine, so the light/dark value is the one
 * actually in force) against the effective background of an anchor element.
 */
async function measureTokenContrast(
  page: Page,
  token: string,
  anchorSelector: string,
): Promise<Measured | null> {
  return page.evaluate(
    ({ tok, sel }: { tok: string; sel: string }) => {
      const parse = (c: string): [number, number, number] => {
        const m = c.match(/rgba?\(([^)]+)\)/)
        if (!m) return [0, 0, 0]
        const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
      }
      const lum = ([r, g, b]: [number, number, number]) => {
        const f = (c: number) => {
          const s = c / 255
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const anchor = document.querySelector(sel) as HTMLElement | null
      if (!anchor) return null
      // Let the engine resolve the token by painting it into a probe element.
      const probe = document.createElement('span')
      probe.style.color = `var(${tok})`
      probe.style.position = 'absolute'
      probe.style.visibility = 'hidden'
      document.body.appendChild(probe)
      const fg = getComputedStyle(probe).color
      probe.remove()

      let bg = 'rgb(255, 255, 255)'
      let node: HTMLElement | null = anchor
      while (node) {
        const c = getComputedStyle(node).backgroundColor
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
          bg = c
          break
        }
        node = node.parentElement
      }
      const l1 = lum(parse(fg))
      const l2 = lum(parse(bg))
      return { fg, bg, ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
    },
    { tok: token, sel: anchorSelector },
  )
}

test.describe('status bar contrast', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('the unsaved label is readable and its ● indicator is visible', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('hello world')
    // The editor's own change path flips the store's dirty flag; wait for it instead of
    // assuming a fixed delay.
    await page.waitForFunction(() => (window as any).__uiStore.getState().dirty === true)

    const label = await measureContrast(page, '[data-testid="status-unsaved"]')
    expect(label, 'the unsaved label must be on screen').not.toBeNull()
    expect(label!.ratio, `unsaved label ${label!.fg} on ${label!.bg}`).toBeGreaterThanOrEqual(4.5)

    // The glyph is an INDICATOR (1.4.11 → 3:1), not text.
    const dot = await measureContrast(page, '[data-testid="status-unsaved-dot"]')
    expect(dot).not.toBeNull()
    expect(dot!.ratio, `unsaved dot ${dot!.fg} on ${dot!.bg}`).toBeGreaterThanOrEqual(3)
  })

  test('the saved label is readable and its ✓ indicator is visible', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.evaluate(() => (window as any).__uiStore.getState().setJustSaved(true))

    const label = await measureContrast(page, '[data-testid="status-saved"]')
    expect(label, 'the saved label must be on screen').not.toBeNull()
    expect(label!.ratio, `saved label ${label!.fg} on ${label!.bg}`).toBeGreaterThanOrEqual(4.5)

    const check = await measureContrast(page, '[data-testid="status-saved-check"]')
    expect(check).not.toBeNull()
    expect(check!.ratio, `saved check ${check!.fg} on ${check!.bg}`).toBeGreaterThanOrEqual(3)
  })

  test('the low-confidence encoding border is visible against the status bar', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()

    // The pill's own low-confidence state needs a file whose detected encoding is uncertain,
    // which the e2e cannot stage cheaply — the CLASS of that state is locked by the unit test
    // (C32 U7). What this spec locks is the COLOUR the engine resolves for that border: the
    // warning token, as an indicator, must clear 3:1 against the status-bar surface, in BOTH
    // themes (the token value differs per theme).
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (window as any).__uiStore.getState().setTheme(t), theme)
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark')

      const border = await measureTokenContrast(
        page,
        '--color-warning',
        '[data-testid="status-word-count"]',
      )
      expect(border, `the ${theme} warning token must resolve`).not.toBeNull()
      expect(
        border!.ratio,
        `${theme} low-confidence border ${border!.fg} on ${border!.bg}`,
      ).toBeGreaterThanOrEqual(3)

      const label = await measureTokenContrast(
        page,
        '--color-text-secondary',
        '[data-testid="status-word-count"]',
      )
      expect(label, `the ${theme} secondary text token must resolve`).not.toBeNull()
      expect(
        label!.ratio,
        `${theme} status label ${label!.fg} on ${label!.bg}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
