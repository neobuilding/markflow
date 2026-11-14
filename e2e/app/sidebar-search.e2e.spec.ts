import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// The sidebar hosts TWO mutually exclusive surfaces (ADR-0023): the file tree and the Search
// view. Content search lives in the Search view — there is no mode switch any more, so filename
// globs are the Ctrl/Cmd+K "Go to file" palette's job (see command-palette.e2e.spec.ts).
// The Search view's own state is session-only and never persisted (Q20).
//
// One app launch for the whole file. The steps are ORDERED so earlier ones cannot pollute later
// ones: the localStorage / styling / empty-state checks run before any file is imported, the
// grouped-count step imports exactly the two files it counts, and the jump step searches a token
// that exists in exactly one file. Seven pure-algorithm examples (regex / whole-word / scope /
// invalid patterns) were moved to `electron/main/lib/content-match.test.ts`,
// `electron/main/lib/scope-filter.test.ts` and `electron/main/ipc/search.test.ts`.
test.describe('sidebar Search view (ADR-0023)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeAll(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-sidebar-search-')
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })

  // Write a real on-disk markdown file, import it through the same IPC the Open File dialog uses
  // (so it carries a real filePath, which content search requires), then activate it.
  async function importFile(page: Page, relPath: string, content: string): Promise<string> {
    const abs = join(scratch, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
    const id = await page.evaluate(
      (f) =>
        window.api.documents.import(f).then((d: any) => {
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
    return id
  }

  // Open the workspace so the Search view has a root to reason about: without one, scope is
  // disabled and content search refuses to run. This sets the MAIN-PROCESS root (the
  // authoritative one the search handler reads via getWorkspaceRoot), not just the renderer's
  // activeFolder — exactly what the Open File dialog flow does.
  async function openWorkspace(page: Page): Promise<void> {
    await page.evaluate((root) => {
      const w = window as any
      w.__uiStore.getState().setActiveFolder(root)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      return window.api.documents.setWorkspaceRoot(root)
    }, scratch)
  }

  // The Files/Search tabs are mutually exclusive, so clicking the Search tab when the view is
  // already open would toggle it CLOSED. Steps share one app instance, so make this idempotent.
  async function openSearchView(page: Page): Promise<void> {
    const input = page.getByTestId('resident-search-input')
    if ((await input.count()) === 0) {
      await page.getByTestId('activity-bar-search').click()
    }
    await expect(input).toBeVisible()
  }

  test('Search view surface, grouped results, and hit navigation', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await test.step('is reached through the sidebar tab and its state is never persisted', async () => {
      // The tree is the default surface; the Search tab is the other one. `aria-expanded` is
      // asserted alongside `aria-selected`: both must agree that a panel is actually showing.
      await expect(page.getByTestId('activity-bar-files')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('activity-bar-files')).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('resident-search-input')).toHaveCount(0)

      await openSearchView(page)
      await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-expanded', 'true')

      // Nothing about the chosen surface is written to persistent storage (Q20).
      const persisted = await page.evaluate(() =>
        Object.keys(window.localStorage).filter((k) => /search|sidebar|view/i.test(k)),
      )
      expect(persisted).toHaveLength(0)

      // Switching back is possible, which is the whole point of a mutually exclusive pair.
      await page.getByTestId('activity-bar-files').click()
      await expect(page.getByTestId('resident-search-input')).toHaveCount(0)
    })

    await test.step('the query field is styled as a field, not as static text', async () => {
      await openSearchView(page)

      // Regression: the magnifier, a borderless transparent <input> and the clear button floated
      // loose on the panel background, so the query box read as a caption rather than a field.
      const box = page.getByTestId('resident-search-box')
      await expect(box).toBeVisible()
      const style = await box.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { borderTop: cs.borderTopWidth, background: cs.backgroundColor }
      })
      expect(parseFloat(style.borderTop)).toBeGreaterThan(0)
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)')

      const fieldBox = await box.boundingBox()
      expect(fieldBox).not.toBeNull()

      // The magnifier sits INSIDE the field's bounds.
      const iconBox = await box.locator('svg').first().boundingBox()
      expect(iconBox).not.toBeNull()
      expect(iconBox!.x).toBeGreaterThanOrEqual(fieldBox!.x)
      expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width)
    })

    // The Search view's empty state speaks for ITSELF (Q7): it used to borrow the command
    // palette's `palette.startTyping` string, so the sidebar quoted another surface. It now has
    // its own key (`sidebar.searchEmptyState`) — the empty state names the results area.
    await test.step('the empty state names the results area with its own copy (Q7)', async () => {
      // No query yet → the empty state is on screen with the sidebar's own wording.
      await expect(page.getByText('Search results', { exact: true })).toBeVisible()
      // The palette's wording must NOT leak into the sidebar.
      await expect(page.getByText('Start typing', { exact: false })).toHaveCount(0)
    })

    await test.step('Ctrl+Shift+F switches to the Search view and focuses its input', async () => {
      // This file contains no "needle", so it cannot perturb the grouped-count step below.
      await importFile(page, 'solo.md', 'body text\n')
      await expect(page.locator('.cm-content')).toBeVisible()

      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.locator('.cm-content').click()
      await page.keyboard.press(`${mod}+Shift+F`)

      await expect(page.getByTestId('resident-search-input')).toBeVisible()
      await expect(page.getByTestId('resident-search-input')).toBeFocused()
      // ONE shortcut, ONE owner — the mirror of the Ctrl+H guard in editor-find-replace: opening
      // the Search view must NOT also open the editor's find panel.
      await expect(page.getByTestId('editor-find')).toBeHidden()
    })

    await test.step('groups hits per file with per-group counts and the global summary', async () => {
      await openWorkspace(page)

      // Two files, three total occurrences of "needle" (solo.md above has none).
      await importFile(page, 'alpha.md', 'needle one\n\nsecond needle here\n')
      await importFile(page, 'beta.md', 'a needle in beta\n')

      await openSearchView(page)
      await page.getByTestId('resident-search-input').pressSequentially('needle')

      // One group per file, one row per in-document occurrence.
      await expect(page.getByTestId('search-group')).toHaveCount(2)
      await expect(page.getByTestId('search-match')).toHaveCount(3)

      // Global hit summary.
      await expect(page.getByTestId('search-summary')).toContainText('3 matches in 2 files')

      // Per-group hit counts (order-independent).
      await expect(page.getByTestId('search-group').filter({ hasText: 'Alpha' })).toContainText('2')
      await expect(page.getByTestId('search-group').filter({ hasText: 'Beta' })).toContainText('1')
    })

    await test.step('clicking a hit in the open document jumps the editor to the hit offset', async () => {
      // A token that exists in EXACTLY ONE file, so the earlier "needle" files cannot add rows.
      await importFile(page, 'jump.md', 'alpha ZUNIQUEHIT omega')
      await page.getByTestId('resident-search-input').fill('ZUNIQUEHIT')
      await expect(page.getByTestId('search-match')).toHaveCount(1)

      await page.getByTestId('search-match').first().click()

      // The jump placed a selection on the matched range in the editor.
      await expect(page.locator('.cm-content')).toBeVisible()
      await expect
        .poll(async () => page.locator('.cm-selectionBackground').count(), { timeout: 5000 })
        .toBeGreaterThan(0)
    })
  })
})
