// Toolbar icon tiles — the design image's contained icon buttons (fig 02/04) + ADR-0024 §1.4.
//
// Why a spec and not a screenshot: the chrome-visual baseline (E9) proves the bars keep their
// SHAPE, but these assertions are about the tokens that make a tile a tile — the fill, the edge,
// the glyph colour in the rest state and in the pressed state, and the diagrams' 1.8px stroke. A
// number is a better witness than a picture here, and it survives a re-baseline.
//
// Scope: the three BARS, exactly like the density spec (E8). The sidebar keeps its compact
// rhythm and the menus keep their 13px inline glyphs, so neither is a tile.
import { expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'

/** Resolved light-theme token values (globals.css §1.1). */
const SURFACE = 'rgb(255, 255, 255)' // --color-surface       #ffffff  - the tile fill
const TILE_EDGE = 'rgb(217, 226, 239)' // --color-border    #d9e2ef  - the tile edge
const REST_GLYPH = 'rgb(83, 97, 118)' // --color-text-secondary #536176 - the rest glyph
const ACTIVE_FILL = 'rgb(234, 242, 255)' // --color-accent-muted #eaf2ff - the pressed tile fill
const ACTIVE = 'rgb(37, 99, 235)' // --color-accent       #2563eb  - the pressed edge + glyph
const STROKE = '1.8px' // the diagrams' toolbar stroke width (lucide defaults to 2px)

const BARS = ['global-bar', 'editor-pane-bar', 'preview-pane-bar'] as const

interface TileProbe {
  testId: string
  fill: string
  edge: string
  glyph: string
  strokeWidth: string
  w: number
  h: number
  /** `aria-pressed` on a toggle, `aria-checked` on a radio — either means "this one is on". */
  on: boolean
}

/**
 * Measure every button of one bar. The glyph colour is read from the element's inherited `color`,
 * which is what the lucide `stroke="currentColor"` glyphs actually paint.
 */
async function probeTiles(page: Page, id: string): Promise<TileProbe[]> {
  return page.evaluate((barId) => {
    const bar = document.querySelector(`[data-testid="${barId}"]`)
    if (!bar) throw new Error(`bar not found: ${barId}`)
    return Array.from(bar.querySelectorAll('button')).map((b) => {
      const el = b as HTMLElement
      const s = getComputedStyle(el)
      const svg = el.querySelector('svg')
      const box = el.getBoundingClientRect()
      return {
        testId: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? '',
        fill: s.backgroundColor,
        edge: s.borderTopColor,
        glyph: svg ? getComputedStyle(svg).color : '',
        strokeWidth: svg ? getComputedStyle(svg).strokeWidth : '',
        w: box.width,
        h: box.height,
        on:
          el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true',
      }
    })
  }, id)
}

test.describe('toolbar icon tiles (design fig 02/04)', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openSplit(page: Page): Promise<void> {
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    await expect(page.getByTestId('preview-pane')).toBeVisible()
  }

  test('every bar icon is a white tile with the cool-blue edge and the muted glyph', async () => {
    const { page } = handle
    await openSplit(page)

    for (const id of BARS) {
      const tiles = await probeTiles(page, id)
      expect(tiles.length, `${id} has no buttons - the probe would be vacuous`).toBeGreaterThan(0)
      for (const t of tiles) {
        if (t.on) {
          // A control that is ON is the accent-tinted tile with an accent edge and an accent glyph.
          expect(t.fill, `${id} > "${t.testId}" pressed fill`).toBe(ACTIVE_FILL)
          expect(t.edge, `${id} > "${t.testId}" pressed edge`).toBe(ACTIVE)
          expect(t.glyph, `${id} > "${t.testId}" pressed glyph`).toBe(ACTIVE)
        } else {
          expect(t.fill, `${id} > "${t.testId}" fill`).toBe(SURFACE)
          expect(t.edge, `${id} > "${t.testId}" edge`).toBe(TILE_EDGE)
          // The ONE glyph allowed to differ from the rest colour: the save button turns accent
          // while the document has unsaved changes — a semantic state, not a tile state.
          if (t.testId !== 'save-btn') {
            expect(t.glyph, `${id} > "${t.testId}" glyph`).toBe(REST_GLYPH)
          }
        }
        // The tile must not cost the hit area (ADR-0024 §1.3 / E8)...
        expect(Math.round(t.w), `${id} > "${t.testId}" is ${t.w}px wide`).toBeGreaterThanOrEqual(32)
        expect(Math.round(t.h), `${id} > "${t.testId}" is ${t.h}px tall`).toBeGreaterThanOrEqual(32)
        // ... and the glyph keeps the diagrams' stroke width.
        if (t.strokeWidth) {
          expect(t.strokeWidth, `${id} > "${t.testId}" stroke`).toBe(STROKE)
        }
      }
    }
  })

  test('the view mode is a radio group: one checked radio, one Tab stop, arrows move and select', async () => {
    const { page } = handle
    await openSplit(page)

    const group = page.getByRole('radiogroup', { name: 'View mode' })
    await expect(group).toBeVisible()
    await expect(group.getByRole('radio')).toHaveCount(3)

    // The checked radio is the accent-tinted tile; the other two are rest tiles.
    await expect(page.getByTestId('view-split')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('view-split')).toHaveCSS('background-color', ACTIVE_FILL)
    await expect(page.getByTestId('view-split')).toHaveCSS('border-top-color', ACTIVE)
    await expect(page.getByTestId('view-edit')).toHaveCSS('background-color', SURFACE)
    await expect(page.getByTestId('view-preview')).toHaveCSS('background-color', SURFACE)

    // Roving tabindex: only the checked radio is in the tab order.
    await expect(page.getByTestId('view-split')).toHaveAttribute('tabindex', '0')
    await expect(page.getByTestId('view-edit')).toHaveAttribute('tabindex', '-1')
    await expect(page.getByTestId('view-preview')).toHaveAttribute('tabindex', '-1')

    // Arrow keys move AND select (APG radio group).
    await page.getByTestId('view-split').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('view-preview')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('view-preview')).toBeFocused()
  })

  test('the sidebar toggle reports its state as a pressed tile', async () => {
    const { page } = handle
    await openSplit(page)

    const toggle = page.getByTestId('sidebar-toggle-btn')
    // The sidebar is open, so the toggle is ON: the accent-tinted tile.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle).toHaveCSS('background-color', ACTIVE_FILL)
    await expect(toggle).toHaveCSS('border-top-color', ACTIVE)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveCSS('background-color', SURFACE)
    await expect(toggle).toHaveCSS('border-top-color', TILE_EDGE)
  })
})
