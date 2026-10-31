// Focus-visibility e2e (PLAN C32 E2 / E2b / E3 / E7)
// Covers the accessibility contract of ADR-0024 §7.2 — "every focusable control has exactly ONE
// visible focus indicator" — plus the `color-scheme` declaration of ADR-0024 §11 item 33.
//
// Why a real Chromium run: the indicator is `:focus-visible`-gated, and jsdom has no cascade,
// no `:focus-visible` and no `getComputedStyle`. Only a real engine can answer "is there a ring?".
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

interface FocusState {
  testId: string
  tag: string
  /** A painted outline (`.focus-ring` paints one). */
  outline: boolean
  /** A painted ring (Tailwind's `focus-visible:ring-2` paints a box-shadow). */
  ring: boolean
  outlineWidth: string
  outlineColor: string
}

/** Read the focus indicator state of whatever currently holds focus. */
async function activeFocusState(page: Page): Promise<FocusState | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body || el === document.documentElement) return null
    const s = getComputedStyle(el)
    return {
      testId: el.getAttribute('data-testid') ?? '',
      tag: el.tagName.toLowerCase(),
      outline: parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none',
      ring: s.boxShadow !== 'none' && s.boxShadow !== '',
      outlineWidth: s.outlineWidth,
      outlineColor: s.outlineColor,
    }
  })
}

/** The controls this spec watches. Each one must paint exactly one indicator when focused. */
const WATCHED = new Set([
  'activity-bar-files',
  'activity-bar-search',
  'new-document-btn',
  'editor-find-btn',
  'editor-replace-btn',
  'status-word-count',
])

test.describe('focus visibility', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('every watched control shows exactly one focus indicator when reached by keyboard', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Sweep the tab order. Tab is a keyboard interaction, so `:focus-visible` matches on the
    // landed control (a programmatic focus() would not).
    const checked = new Set<string>()
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab')
      const state = await activeFocusState(page)
      if (!state || !WATCHED.has(state.testId)) continue
      checked.add(state.testId)
      // EXACTLY one indicator: an outline XOR a ring. Two indicators read as a broken control
      // (ADR-0024 §7.2); none at all is a WCAG 2.4.7 failure.
      expect(
        state.outline !== state.ring,
        `${state.testId}: outline=${state.outline} ring=${state.ring}`,
      ).toBe(true)
    }

    // Guard against a vacuous pass: the sweep must actually have reached the controls.
    expect(checked.size, `reached: ${[...checked].join(', ')}`).toBeGreaterThanOrEqual(3)
  })

  test('a menu item reached by arrow keys shows the focus ring, a hovered one does not', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await page.getByTestId('sidebar-welcome-state').click({ button: 'right' })
    const item = page.getByTestId('side-new-document')
    await expect(item).toBeVisible()

    // Arrow-key navigation is the case that NEEDS the ring: the background swap alone is ~1.1:1
    // against the menu surface, far below the 3:1 of WCAG 1.4.11.
    await page.keyboard.press('ArrowDown')
    // NOTE: `transition-colors` also transitions `outline-color`, so the ring FADES IN over
    // ~100ms. Sampling the colour immediately would read the pre-transition value, so poll.
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return null
      const s = getComputedStyle(el)
      return {
        testId: el.getAttribute('data-testid') ?? '',
        role: el.getAttribute('role') ?? '',
        outline: parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none',
        ring: s.boxShadow !== 'none' && s.boxShadow !== '',
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
      }
    })
    expect(focused, 'something must hold focus after the arrow key').not.toBeNull()
    // The ring belongs to a MENU ITEM, not to the menu container or the trigger.
    expect(focused!.role, `focused: ${JSON.stringify(focused)}`).toBe('menuitem')
    expect(focused!.outline, `focused: ${JSON.stringify(focused)}`).toBe(true)
    expect(focused!.outlineWidth).toBe('2px')
    // The ring is painted in the accent token (light theme: #2563eb).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null
            return el ? getComputedStyle(el).outlineColor : ''
          }),
        { timeout: 5000 },
      )
      .toBe('rgb(37, 99, 235)')

    // A pointer-hovered item must NOT grow a ring: `:focus-visible` does not match for pointers.
    const hovered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="side-open-folder"]') as HTMLElement | null
      if (!el) return null
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      const s = getComputedStyle(el)
      return {
        outline: parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none',
        ring: s.boxShadow !== 'none' && s.boxShadow !== '',
      }
    })
    expect(hovered).not.toBeNull()
    expect(hovered!.outline).toBe(false)
    expect(hovered!.ring).toBe(false)
  })

  test('the focus ring survives forced-colors mode', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Windows high-contrast / forced-colors flattens the menu background swap, so the ring is
    // re-asserted as a system outline (globals.css `@media (forced-colors: active)`).
    await page.emulateMedia({ forcedColors: 'active' })

    await page.keyboard.press('Tab')
    let state = await activeFocusState(page)
    // The first Tab stop may not be a watched control — keep tabbing until one is reached.
    for (let i = 0; i < 30 && (!state || !WATCHED.has(state.testId)); i++) {
      await page.keyboard.press('Tab')
      state = await activeFocusState(page)
    }
    expect(state, 'no watched control was reached').not.toBeNull()
    expect(WATCHED.has(state!.testId)).toBe(true)
    expect(
      parseFloat(state!.outlineWidth),
      'the forced-colors ring must not disappear',
    ).toBeGreaterThan(0)
  })

  test('color-scheme follows the active theme', async () => {
    const { page } = handle
    await waitForAppReady(page)

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'light',
    )

    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true)

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'dark',
    )
  })
})
