import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// Shortcuts that switch or fold the sidebar, plus the width floor the Search view has to
// survive (PLAN C5 / C9, ADR-0024 §2.5).
//
// These are the behaviours that are EASY to break silently: the activity bar re-render, the
// focus hand-off, or a shortcut that ends up claimed by two owners. A shortcut that fires
// twice (renderer handler + native menu event) looks fine in a screenshot and is invisible in
// a unit test — only the real app shows it, so these assertions live here.
//
// The modifier follows the platform, exactly like the renderer's own handler does
// (App.tsx: `isMac ? e.metaKey : e.ctrlKey`).
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test.describe('sidebar shortcuts and the activity bar', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-sidebar-shortcuts-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Open a real document on disk and activate it through the store. Needed whenever a command
  // is gated on "a file is open" — the export menu item ships `enabled: false` and is switched
  // on by the renderer's synced `hasDocument` state (electron/main/menu.ts).
  async function openDocument(page: Page, relPath: string, content: string): Promise<void> {
    const abs = join(scratch, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    const id = await page.evaluate(
      (f) =>
        (window as any).api.documents.import(f).then((d: any) => {
          if (!d) throw new Error('documents.import returned null')
          return d.id
        }),
      abs,
    )
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
  }

  test('the activity bar stays visible while the content panel is folded', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await expect(page.getByTestId('activity-bar-files')).toBeVisible()
    await expect(page.getByRole('tabpanel')).toBeVisible()

    // ⌘B folds the CONTENT PANEL only — the icon column is always there (VS Code's
    // `toggleSidebarVisibility` toggles the sidebar PART and keeps the activity bar).
    await page.keyboard.press(`${mod}+B`)
    await expect(page.getByRole('tabpanel')).toHaveCount(0)
    await expect(page.getByTestId('activity-bar-files')).toBeVisible()
    await expect(page.getByTestId('activity-bar-search')).toBeVisible()
    // A folded bar owns no panel, so neither tab may claim one.
    await expect(page.getByTestId('activity-bar-files')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('activity-bar-files')).toHaveAttribute('aria-expanded', 'false')
  })

  // ⌘B is renderer-only (the native menu carries no `CmdOrCtrl+B` accelerator), so it has
  // exactly ONE owner and must fire exactly ONCE. If two handlers ever claimed it, the panel
  // would fold and unfold again in the same tick and end up where it started — a double-fire
  // that is invisible everywhere except here.
  test('⌘B folds and unfolds the content panel exactly once per press', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await expect(page.getByRole('tabpanel')).toBeVisible()

    await page.keyboard.press(`${mod}+B`)
    await expect(page.getByRole('tabpanel')).toHaveCount(0)

    await page.keyboard.press(`${mod}+B`)
    await expect(page.getByRole('tabpanel')).toBeVisible()
    await expect(page.getByTestId('activity-bar-files')).toHaveAttribute('aria-selected', 'true')
  })

  // ⌘\ is the OTHER binding of the same command. It has BOTH a native accelerator
  // (`CmdOrCtrl+\` → the 'toggle-sidebar' menu event) and a renderer-side handler, which is
  // the "two owners for one command" shape ADR-0024 §2.5 warns about.
  //
  // This asserts the renderer path toggles exactly ONCE. The native path cannot be exercised
  // here: a menu accelerator is consumed by the OS menu and never reaches the page, so
  // Playwright's key events never reach it. In practice the OS delivers the key to exactly one
  // of the two (the menu wins, and the renderer branch is the fallback that also carries the
  // modal guard) — the assertion below locks the half that IS drivable.
  test('⌘\\ still toggles the sidebar exactly once', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await expect(page.getByRole('tabpanel')).toBeVisible()

    await page.keyboard.press(`${mod}+Backslash`)
    await expect(page.getByRole('tabpanel')).toHaveCount(0)

    await page.keyboard.press(`${mod}+Backslash`)
    await expect(page.getByRole('tabpanel')).toBeVisible()
  })

  // ⌘⇧E = Files view (VS Code `workbench.view.explorer`), symmetric with ⌘⇧F = Search.
  test('⌘⇧E switches to the Files view, expands the sidebar and hands focus to the panel', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Start from the Search view so the switch is observable.
    await page.getByTestId('activity-bar-search').click()
    await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press(`${mod}+Shift+E`)

    await expect(page.getByTestId('activity-bar-files')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByRole('tabpanel')).toBeVisible()
    // WCAG 2.4.3: a programmatic switch must move focus into the target panel, not leave it
    // on the old surface. The panel is focusable precisely so this hand-off has a target.
    await expect(page.getByRole('tabpanel')).toBeFocused()
  })

  // The export command MOVED from ⌘⇧E to ⌘⇧X so that ⌘⇧E could belong to the Files view.
  //
  // A native menu accelerator is consumed by the OS menu and never reaches the page, so
  // Playwright's `keyboard.press` CANNOT drive it (it dispatches DOM key events into the
  // renderer). The binding is therefore asserted on the MENU ITEM itself, and the command is
  // exercised by activating that item — which is exactly what the OS does on a real keypress.
  test('the export command owns ⌘⇧X and nothing claims ⌘⇧E', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // The export command is disabled while no file is open, so the shortcut needs a document.
    await openDocument(page, 'doc.md', '# Title\n\nbody\n')
    await expect(page.locator('.cm-content')).toBeVisible()
    // Wait for the menu item to actually be enabled in the MAIN process before activating it.
    await expect
      .poll(() =>
        handle.electronApp.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById('export-html')
          return item?.enabled === true
        }),
      )
      .toBe(true)

    const binding = await handle.electronApp.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const all: { id: string; label: string; accelerator: string }[] = []
      const walk = (items: any[]) => {
        for (const item of items) {
          all.push({
            id: item.id ?? '',
            label: item.label ?? '',
            accelerator: item.accelerator ?? '',
          })
          if (item.submenu) walk(item.submenu.items)
        }
      }
      walk(menu?.items ?? [])
      return {
        exportAccelerator: menu?.getMenuItemById('export-html')?.accelerator ?? '',
        shiftEOwners: all.filter((i) => i.accelerator === 'CmdOrCtrl+Shift+E'),
      }
    })
    // The export command moved to ⌘⇧X…
    expect(binding.exportAccelerator).toBe('CmdOrCtrl+Shift+X')
    // …and NOTHING may claim ⌘⇧E: that combination belongs to the Files view, which the
    // RENDERER owns. A menu item holding it would swallow the shortcut and break the switch.
    expect(binding.shiftEOwners).toHaveLength(0)

    await page.getByTestId('activity-bar-search').click()
    await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-selected', 'true')

    // Activating the menu item is what the OS does on a real ⌘⇧X press.
    await handle.electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('export-html')?.click()
    })

    await expect(page.getByRole('dialog')).toBeVisible()
    // The view did not move: the export command owns ⌘⇧X and nothing else.
    await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-selected', 'true')

    // Close the dialog before quitting: an open export dialog hard-locks the close flow
    // (the app deliberately refuses to quit while exporting), which would turn the graceful
    // teardown into a 15s timeout + force-kill.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  // C9's width acceptance line: at the 240px floor (48px activity bar + 192px content panel)
  // the Search view's primary row must not overflow and the query input must keep at least
  // 80px of usable width. Shrinking the type is NOT an option (PLAN C13).
  test('the Search view survives the 240px sidebar floor (C9 width acceptance)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Drag the resize handle down to the floor. The handle sits on the panel's right edge and
    // the sidebar starts at x=0, so clientX 240 IS the total sidebar width.
    const resizeHandle = page.getByTestId('sidebar-resize-handle')
    const box = await resizeHandle.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(240, box!.y + box!.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue('--sidebar-width')),
      )
      .toBe('240px')

    await page.getByTestId('activity-bar-search').click()
    const primaryRow = page.getByTestId('resident-search-box')
    await expect(primaryRow).toBeVisible()

    // 1. The primary row fits its own box.
    const overflow = await primaryRow.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    // 2. The query input keeps a usable width.
    const input = await page.getByTestId('resident-search-input').boundingBox()
    expect(input).not.toBeNull()
    expect(input!.width).toBeGreaterThanOrEqual(80)

    // 3. The secondary row stays on ONE line: [ab] and [.*] share the same top edge, and
    //    neither is clipped by the panel edge.
    const ab = await page.getByTestId('search-advanced-toggles-ab').boundingBox()
    const dot = await page.getByTestId('search-advanced-toggles-.*').boundingBox()
    expect(ab).not.toBeNull()
    expect(dot).not.toBeNull()
    expect(Math.abs(ab!.y - dot!.y)).toBeLessThan(2)

    const panel = await page.getByRole('tabpanel').boundingBox()
    expect(panel).not.toBeNull()
    expect(dot!.x + dot!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1)
  })
})
