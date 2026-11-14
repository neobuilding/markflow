import type {} from '../../src/renderer/src/vite-env.d.ts'
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// Verifies the Cmd/Ctrl+Shift+P menu action (`menu:toggle-preview`) actually cycles the view
// mode end-to-end: native menu → IPC → renderer store → radio group, following the shared
// VIEW_MODE_ORDER (edit → split → preview → edit). Covers the dead-letter fix from the
// follow-up plan (project B, three-state cycle).
test.describe('view-mode cycle (Cmd/Ctrl+Shift+P)', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Click the native "Cycle View" menu item by id; its handler sends `menu:toggle-preview` to the
  // renderer, exactly as a real user would via the application menu.
  async function clickTogglePreview(): Promise<void> {
    await handle.electronApp.evaluate((electron) => {
      const { Menu } = electron
      const menu = Menu.getApplicationMenu()
      if (!menu) throw new Error('no application menu')
      type Item = { id?: string; click?: () => void; submenu?: { items?: Item[] } }
      let target: Item | undefined
      const walk = (items: Item[]): void => {
        for (const item of items) {
          if (item.id === 'toggle-preview' && typeof item.click === 'function') {
            target = item
            return
          }
          if (item.submenu?.items) walk(item.submenu.items)
        }
      }
      walk(menu.items as unknown as Item[])
      if (!target) throw new Error('toggle-preview menu item not found')
      target.click!()
    }, undefined)
  }

  // The live view mode, read straight from the renderer store (the source of truth the menu
  // updates). Exposed as `window.__uiStore` in dev builds — the same global other e2e specs use.
  async function storeMode(): Promise<string> {
    return handle.page.evaluate(
      () =>
        (
          window as unknown as {
            __uiStore: { getState: () => { viewMode: string } }
          }
        ).__uiStore.getState().viewMode,
    )
  }

  // The radio group only mounts once a document is open; assert the DOM reflects the store too.
  async function domMode(): Promise<string> {
    for (const mode of ['edit', 'split', 'preview'] as const) {
      const checked = await handle.page.getByTestId(`view-${mode}`).getAttribute('aria-checked')
      if (checked === 'true') return mode
    }
    throw new Error('no view-mode radio checked')
  }

  test('cycles edit → split → preview → edit through the native menu', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Open a document so the editor (and its view-mode radio group) mounts.
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()

    // Default view mode is 'split' (store + DOM agree).
    expect(await storeMode()).toBe('split')
    expect(await domMode()).toBe('split')

    await clickTogglePreview()
    await page.waitForTimeout(120)
    expect(await storeMode()).toBe('preview')
    expect(await domMode()).toBe('preview')

    await clickTogglePreview()
    await page.waitForTimeout(120)
    expect(await storeMode()).toBe('edit')
    expect(await domMode()).toBe('edit')

    await clickTogglePreview()
    await page.waitForTimeout(120)
    expect(await storeMode()).toBe('split')
    expect(await domMode()).toBe('split')
  })
})
