// Toolbar density e2e (PLAN C32 E8 / ADR-0024 §1.3)
//
// ADR-0024 §1.3 ("Icon and target sizes") moves the chrome to 16px icons and 32-36px hit
// areas, and the two pane bars to `h-9` (36px). E8 is the executable form of that rule:
// every button on the three bars must offer a >= 32px target, and every icon inside those
// buttons must render at exactly 16px.
//
// Why a spec and not a screenshot: the numbers are the requirement. A screenshot proves one
// moment at one window size; this proves the geometry on every run, in the app's real cascade.
//
// Scope: the three BARS only. The sidebar is the density exception registered in ADR-0024
// §1.3 (its rows stay at the 4/8px rhythm and 28px tall), and menu/list rows keep their
// 13px inline glyphs on purpose (PLAN C23 "menu item icons stay 13px").
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

const MIN_HIT_PX = 32
const ICON_PX = 16
const PANE_BAR_PX = 36

const BARS = ['global-bar', 'editor-pane-bar', 'preview-pane-bar'] as const

interface ButtonBox {
  label: string
  w: number
  h: number
}

interface IconBox {
  label: string
  w: number
  h: number
}

interface BarProbe {
  id: string
  height: number
  buttons: ButtonBox[]
  icons: IconBox[]
}

/**
 * Measure one bar in the page: the row height, every button's box and every icon's box.
 * One round trip per bar, and the numbers come from `getBoundingClientRect` (the rendered
 * geometry), not from the class names.
 */
async function probeBar(page: Page, id: string): Promise<BarProbe> {
  return page.evaluate((barId) => {
    const bar = document.querySelector(`[data-testid="${barId}"]`)
    if (!bar) throw new Error(`bar not found: ${barId}`)
    const label = (el: Element): string =>
      el.getAttribute('data-testid') ??
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').trim().slice(0, 24)
    return {
      id: barId,
      height: bar.getBoundingClientRect().height,
      buttons: Array.from(bar.querySelectorAll('button')).map((b) => {
        const box = b.getBoundingClientRect()
        return { label: label(b), w: box.width, h: box.height }
      }),
      icons: Array.from(bar.querySelectorAll('button svg')).map((s) => {
        const box = s.getBoundingClientRect()
        return { label: label(s.parentElement ?? s), w: box.width, h: box.height }
      }),
    }
  }, id)
}

/** Assert the >= 32px hit area on every button of the given bars. */
async function assertBarsHitArea(page: Page, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const bar = await probeBar(page, id)
    expect(bar.buttons.length, `${id} has no buttons - the probe would be vacuous`).toBeGreaterThan(
      0,
    )
    for (const b of bar.buttons) {
      expect(b.h, `${id} > button "${b.label}" is ${b.h}px tall`).toBeGreaterThanOrEqual(MIN_HIT_PX)
      expect(b.w, `${id} > button "${b.label}" is ${b.w}px wide`).toBeGreaterThanOrEqual(MIN_HIT_PX)
    }
  }
}

test.describe('toolbar density (E8)', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openSplitWithDoc(page: Page): Promise<void> {
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('hello world')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    await expect(page.getByTestId('preview-pane')).toBeVisible()
  }

  test('every bar button offers a >= 32px hit area', async () => {
    const { page } = handle
    await openSplitWithDoc(page)
    await assertBarsHitArea(page, BARS)
  })

  test('every view mode keeps the hit areas on the bars it renders', async () => {
    const { page } = handle
    await openSplitWithDoc(page)

    // edit-only: the preview pane stays MOUNTED but is hidden (EditorPane.tsx keeps it on screen
    // with `hidden` so the background bakes keep running — ADR-0024 §11 trade-off 50 records
    // exactly this asymmetry), so its bar is present-but-hidden, not absent.
    await page.getByTestId('view-edit').click()
    await expect(page.getByTestId('editor-pane-bar')).toBeVisible()
    await expect(page.getByTestId('preview-pane-bar')).toBeHidden()
    await assertBarsHitArea(page, ['global-bar', 'editor-pane-bar'])

    // preview-only: the editor pane IS unmounted, so its bar is gone from the DOM.
    await page.getByTestId('view-preview').click()
    await expect(page.getByTestId('preview-pane-bar')).toBeVisible()
    await expect(page.getByTestId('editor-pane-bar')).toHaveCount(0)
    await assertBarsHitArea(page, ['global-bar', 'preview-pane-bar'])
  })

  test('the folded format menu keeps a >= 32px target for every entry', async () => {
    const { page } = handle
    await openSplitWithDoc(page)

    // Narrow the window until the editor column drops below the 420px fold threshold, which
    // collapses the seven format buttons into one dropdown (ADR-0024 §10 trade-off 54).
    // `setSize` is a no-op on a MAXIMIZED window, so un-maximize first; the window's minWidth is
    // 800 (electron/main/window.ts), which still leaves each split column under 420px.
    await handle.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())
      if (!win) throw new Error('no visible window')
      if (win.isMaximized()) win.unmaximize()
      win.setSize(800, 760)
    })
    // Guard the premise before asserting the result: a window that refused to shrink would
    // otherwise surface as an opaque "element not found" timeout instead of this message.
    const editorBar = page.getByTestId('editor-pane-bar')
    await expect
      .poll(async () => (await editorBar.boundingBox())?.width ?? 0, {
        message: 'the editor column must be narrow enough (< 420px) to fold',
      })
      .toBeLessThan(420)

    const foldBtn = page.getByTestId('fmt-dropdown-btn')
    await expect(foldBtn).toBeVisible({ timeout: 15_000 })

    await foldBtn.click()
    const items = page.getByRole('menuitem')
    const count = await items.count()
    expect(count, 'the folded menu must list every format action').toBe(7)
    for (let i = 0; i < count; i++) {
      const box = await items.nth(i).boundingBox()
      expect(box, `format menu item #${i} has no box`).not.toBeNull()
      expect(box!.height, `format menu item #${i} is ${box!.height}px tall`).toBeGreaterThanOrEqual(
        MIN_HIT_PX,
      )
      expect(box!.width, `format menu item #${i} is ${box!.width}px wide`).toBeGreaterThanOrEqual(
        MIN_HIT_PX,
      )
    }
  })

  test('every bar icon renders at 16px', async () => {
    const { page } = handle
    await openSplitWithDoc(page)

    for (const id of BARS) {
      const bar = await probeBar(page, id)
      expect(bar.icons.length, `${id} has no icons - the probe would be vacuous`).toBeGreaterThan(0)
      for (const icon of bar.icons) {
        expect(icon.w, `${id} > icon in "${icon.label}" is ${icon.w}px wide`).toBeCloseTo(
          ICON_PX,
          0,
        )
        expect(icon.h, `${id} > icon in "${icon.label}" is ${icon.h}px tall`).toBeCloseTo(
          ICON_PX,
          0,
        )
      }
    }
  })

  test('the two pane bars are h-9 (36px) and the global bar keeps the 38px titlebar height', async () => {
    const { page } = handle
    await openSplitWithDoc(page)

    // ADR-0024 §1.3: the pane bars are toolbar rows of `h-9`. The global bar is the window
    // drag region and keeps `--titlebar-height` (38px) - "3 bars, 3 documented heights",
    // not an accident (PLAN C23 boundary ③).
    for (const id of ['editor-pane-bar', 'preview-pane-bar'] as const) {
      const bar = await probeBar(page, id)
      expect(bar.height, `${id} is ${bar.height}px tall`).toBeCloseTo(PANE_BAR_PX, 0)
    }
    const global = await probeBar(page, 'global-bar')
    expect(global.height, 'global-bar is not 38px').toBeCloseTo(38, 0)
  })
})
