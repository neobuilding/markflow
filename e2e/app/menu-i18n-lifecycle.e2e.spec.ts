import type {} from '../../src/renderer/src/vite-env.d.ts'
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// Covers two Plan areas the existing e2e specs never reached:
//
// 1. + native menu language sync. `app:set-language` (moved into
//     registerMenuHandlers() in menu.ts) must keep the native application menu
// labels in sync with the renderer language. Note that this handler was
// originally registered inside whenReady and is now registered before it;
// verify the menu actually re-localizes
//
// 2. + (window.ts) the unsaved-changes CLOSE guard. Closing a window sends
//     `app:request-quit` to that renderer, which opens the app-modal
//     `dialog:confirm` (the focus-bug fix from R1). There is no application-level
//     quit handshake: app.quit() closes each window, so the same guard runs. We
//     assert that path still fires end-to-end.
test.describe('native menu i18n + window-close lifecycle', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function menuLabels(): Promise<string[]> {
    // Read the live native application menu template from the main process.
    // Menu.getApplicationMenu() returns the built Menu; .items gives the top-level
    // entries whose .label is localized by the menu i18n layer.
    return handle.electronApp
      .evaluate((electron) => {
        const { Menu } = electron
        const menu = Menu.getApplicationMenu()
        if (!menu) return []
        return menu.items.map((i) => i.label).filter((l): l is string => typeof l === 'string')
      }, undefined)
      .catch(() => [])
  }

  // Same read, but recursive: submenu labels are where the `role`-based items live, and
  // those are the ones Electron would otherwise render with its own (system-locale) text.
  async function allMenuLabels(): Promise<string[]> {
    return handle.electronApp
      .evaluate((electron) => {
        type Item = { label: string; submenu?: { items?: Item[] } }
        const { Menu } = electron
        const menu = Menu.getApplicationMenu()
        if (!menu) return []
        const out: string[] = []
        const walk = (items: Item[]): void => {
          for (const item of items) {
            if (typeof item.label === 'string') out.push(item.label)
            const sub = item.submenu?.items
            if (Array.isArray(sub)) walk(sub)
          }
        }
        walk(menu.items as unknown as Item[])
        return out
      }, undefined)
      .catch(() => [])
  }

  test('switching language updates the native menu labels', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Force English first (helpers already pin English, but be explicit).
    await page.evaluate(() => window.api.app.setLanguage('en'))
    await page.waitForTimeout(150)
    const enLabels = await menuLabels()

    // Switch to Chinese via the bridge (drives app:set-language in registerMenuHandlers).
    await page.evaluate(() => window.api.app.setLanguage('zh-CN'))
    await page.waitForTimeout(200)
    const zhLabels = await menuLabels()

    // Behavior is unchanged: the menu must re-localize.
    // At minimum, the label sets must differ (some entry changed language), and
    // both must be non-empty (menu built successfully after the split).
    expect(enLabels.length).toBeGreaterThan(0)
    expect(zhLabels.length).toBeGreaterThan(0)
    expect(zhLabels).not.toEqual(enLabels)

    // Reset to English so other specs (which assume English) are not affected.
    await page.evaluate(() => window.api.app.setLanguage('en'))
  })

  // Electron renders a bare `role` (undo / copy / zoomIn / minimize / quit …) with its OWN
  // label, which follows the *system* locale — so those entries stayed English after an in-app
  // switch to Chinese. They must now carry the menuT() label from the shared dictionary.
  test('role-based menu items follow the in-app language, not the system locale', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await page.evaluate(() => window.api.app.setLanguage('zh-CN'))
    await page.waitForTimeout(200)
    const zhLabels = await allMenuLabels()

    for (const label of [
      '撤销',
      '重做',
      '剪切',
      '复制',
      '粘贴',
      '实际大小',
      '放大',
      '缩小',
      '切换全屏',
      '最小化',
      '缩放',
      '关闭窗口',
    ]) {
      expect(zhLabels, `missing localized menu label ${label}`).toContain(label)
    }
    // No application-level Quit entry: the File menu ends with Close Window.
    expect(zhLabels).not.toContain('退出')
    // The English role defaults must be gone entirely.
    for (const label of [
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Actual Size',
      'Zoom In',
      'Zoom Out',
      'Toggle Full Screen',
      'Minimize',
      'Zoom',
      'Quit',
      'Close Window',
    ]) {
      expect(zhLabels, `English role label ${label} leaked into the Chinese menu`).not.toContain(
        label,
      )
    }

    await page.evaluate(() => window.api.app.setLanguage('en'))
    await page.waitForTimeout(200)
    const enLabels = await allMenuLabels()
    for (const label of ['Undo', 'Copy', 'Minimize']) {
      expect(enLabels, `missing English menu label ${label}`).toContain(label)
    }
  })

  // The fix must localize the TEXT only: the role still owns the native action and the
  // platform accelerator, so dropping it would break Ctrl+Z / F11 even though the menu looks right.
  test('relabeled role items keep their role and built-in accelerator', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.evaluate(() => window.api.app.setLanguage('zh-CN'))
    await page.waitForTimeout(200)

    const items = (await handle.electronApp
      .evaluate((electron) => {
        type Item = {
          label: string
          role?: string
          accelerator?: string | null
          submenu?: { items?: Item[] }
        }
        const { Menu } = electron
        const menu = Menu.getApplicationMenu()
        if (!menu) return []
        const out: Array<{ label: string; role: string; accelerator: string | null }> = []
        const walk = (list: Item[]): void => {
          for (const item of list) {
            if (item.role) {
              out.push({
                label: item.label,
                role: item.role,
                accelerator: item.accelerator ?? null,
              })
            }
            const sub = item.submenu?.items
            if (Array.isArray(sub)) walk(sub)
          }
        }
        walk(menu.items as unknown as Item[])
        return out
      }, undefined)
      .catch(() => [])) as Array<{ label: string; role: string; accelerator: string | null }>

    expect(items.length).toBeGreaterThan(0)

    // Roles that Electron gives a built-in accelerator to must still declare it after the
    // relabel (`close` has no accelerator here, so it is excluded on purpose).
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'minimize']) {
      const item = items.find((i) => i.role === role)
      expect(item, `role ${role} must still be present`).toBeDefined()
      expect(item?.accelerator, `role ${role} must keep its accelerator`).toBeTruthy()
    }
    // Close Window survives; the app-level Quit role is gone.
    expect(items.find((i) => i.role === 'close')).toBeDefined()
    expect(items.find((i) => i.role === 'quit')).toBeUndefined()

    // And the label really is the localized one, i.e. the role survived *together with* the text.
    expect(items.find((i) => i.role === 'undo')?.label).toBe('撤销')
    expect(items.find((i) => i.role === 'minimize')?.label).toBe('最小化')

    await page.evaluate(() => window.api.app.setLanguage('en'))
  })

  // The native menu's TOP-LEVEL ORDER is a product decision (ADR-0031 R-e): the platform's own
  // menus in their conventional order, MarkFlow's language menu after them, Help last.
  // File / Edit / View / Window / Language / Help — asserted on the LIVE built menu, not on the template.
  test('the native menu keeps the conventional top-level order', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // The labels are localized, so pin the language first (the menu is rebuilt on the switch).
    await page.evaluate(() => window.api.app.setLanguage('en'))
    await expect
      .poll(() => menuLabels(), { message: 'the native menu must expose its six top-level menus' })
      .toEqual(['File', 'Edit', 'View', 'Window', 'Language', 'Help'])
  })

  test('menu state IPC (menu:set-*) reaches the main process without error', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // menu.ts (, moved with its handlers into registerMenuHandlers) exposes
    // setEditable / setHasDocument / setFileLocked to the renderer. After the split
    // these must still deliver to the menu without throwing.
    await page.evaluate(() => {
      window.api.menu.setEditable(true)
      window.api.menu.setHasDocument(true)
      window.api.menu.setFileLocked(false)
    })
    // If the handlers weren't registered (e.g. registerMenuHandlers) the calls
    // would still resolve (fire-and-forget), so we additionally verify the menu
    // still exists/responds afterward.
    await expect.poll(() => menuLabels()).not.toEqual([])
  })

  test('app.quit() closes windows through the per-window guard (no app-level handshake)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // With app-level quit removed, app.quit() (used by the OS / Dock and by the
    // single-instance loser) no longer runs a before-quit veto. Electron closes each
    // window, and window.ts's close handler still sends 'app:request-quit' to that
    // renderer; with no dirty document the renderer answers 'app:quit-allowed' and the
    // window closes. We verify the whole path end-to-end WITHOUT a native modal: the
    // preload bridge is frozen (dialog.confirm cannot be stubbed), and a clean
    // workspace has no prompt.
    const closed = new Promise<void>((resolve) => handle.electronApp.on('close', () => resolve()))

    await handle.electronApp.evaluate((electron) => {
      electron.app.quit()
    }, undefined)

    // The app exits only if each window's close guard completed. If the split dropped
    // the window handler or the renderer listener, this times out.
    await closed
  })
})
