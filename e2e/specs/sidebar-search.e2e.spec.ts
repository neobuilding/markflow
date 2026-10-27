import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// The sidebar hosts TWO mutually exclusive surfaces (ADR-0023): the file tree and the Search
// view. Content search lives in the Search view — there is no mode switch any more, so filename
// globs are the Ctrl/Cmd+K "Go to file" palette's job (see command-palette.e2e.spec.ts).
// The Search view's own state is session-only and never persisted (Q20).
// DOM is addressed by testids: sidebar-view-{files,search}, resident-search-{input,box},
// search-{include,exclude,match,group,summary,diagnostic}.
test.describe('sidebar Search view (ADR-0023)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-sidebar-search-')
  })
  test.afterEach(async () => {
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

  async function openSearchView(page: Page): Promise<void> {
    await page.getByTestId('sidebar-view-search').click()
    await expect(page.getByTestId('resident-search-input')).toBeVisible()
  }

  test('is reached through the sidebar tab and its state is never persisted', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // The tree is the default surface; the Search tab is the other one.
    await expect(page.getByTestId('sidebar-view-files')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('resident-search-input')).toHaveCount(0)

    await openSearchView(page)
    await expect(page.getByTestId('sidebar-view-search')).toHaveAttribute('aria-selected', 'true')

    // Nothing about the chosen surface is written to persistent storage (Q20).
    const persisted = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((k) => /search|sidebar|view/i.test(k)),
    )
    expect(persisted).toHaveLength(0)

    // Switching back is possible, which is the whole point of a mutually exclusive pair.
    await page.getByTestId('sidebar-view-files').click()
    await expect(page.getByTestId('resident-search-input')).toHaveCount(0)
  })

  test('groups hits per file with per-group counts and the global summary', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)

    // Two files, three total occurrences of "needle".
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

  test('clicking a hit in the open document jumps the editor to the hit offset', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)

    // A single, already-open document: clicking its hit selects the match in place.
    await importFile(page, 'solo.md', 'alpha needle beta')
    await expect(page.locator('.cm-content')).toContainText('alpha needle beta')

    await openSearchView(page)
    await page.getByTestId('resident-search-input').pressSequentially('needle')
    await expect(page.getByTestId('search-match')).toHaveCount(1)

    await page.getByTestId('search-match').first().click()

    // The jump placed a selection on the matched range in the editor.
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect
      .poll(async () => page.locator('.cm-selectionBackground').count(), { timeout: 5000 })
      .toBeGreaterThan(0)
  })

  test('the query field is styled as a field, not as static text', async () => {
    const { page } = handle
    await waitForAppReady(page)
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

  // The include/exclude pair replaces the old scope popover, and `exclude` must win
  // over the include side (D19).
  test('the exclude pattern removes a file the include side would match', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'docs/keep.md', 'needle in docs\n')
    await importFile(page, 'archive/drop.md', 'needle in archive\n')

    await openSearchView(page)
    await page.getByTestId('search-toggle-details').click()
    await page.getByTestId('search-include').fill('**/*.md')
    await page.getByTestId('resident-search-input').pressSequentially('needle')

    await expect(page.getByTestId('search-group')).toHaveCount(2)

    // Excluding `./archive` must drop exactly one of them, not filter by nothing (D19).
    await page.getByTestId('search-exclude').fill('./archive')
    await expect(page.getByTestId('search-group')).toHaveCount(1)
    await expect(page.getByTestId('search-group').first()).toContainText('keep')
  })

  // An unparseable pattern must NOT silently widen the scope to "everything" (D27).
  test('an invalid exclude pattern blocks the query instead of ignoring it', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'alpha.md', 'needle in alpha\n')

    await openSearchView(page)
    await page.getByTestId('search-toggle-details').click()
    await page.getByTestId('search-exclude').fill('a[bc')
    await page.getByTestId('resident-search-input').pressSequentially('needle')

    await expect(page.getByTestId('search-diagnostic')).toBeVisible()
    // No results are listed while the query is blocked.
    await expect(page.getByTestId('search-match')).toHaveCount(0)
  })

  test('Ctrl+Shift+F switches to the Search view and focuses its input, from the editor', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await importFile(page, 'solo.md', 'body text\n')
    await expect(page.locator('.cm-content')).toBeVisible()

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.locator('.cm-content').click()
    await page.keyboard.press(`${mod}+Shift+F`)

    await expect(page.getByTestId('resident-search-input')).toBeVisible()
    await expect(page.getByTestId('resident-search-input')).toBeFocused()
    // ONE shortcut, ONE owner — the mirror of the Ctrl+H guard in editor-find-replace: opening the
    // Search view must NOT also open the editor's find panel.
    await expect(page.getByTestId('editor-find')).toBeHidden()
  })

  // §13.1 / D30 / D31: the `.*` toggle turns the query into a JS regular expression, shared by
  // display, counting and replace (one compiled matcher). A regex-only construct must match where
  // the same literal text matches nothing.
  test('regex mode matches a pattern the literal query would not (D30/D31)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'alpha.md', 'needle one\nsecond needle here\n')

    await openSearchView(page)
    // Turn on regex FIRST, then type a pattern whose `e+` only makes sense as a regex.
    await page.getByTestId('search-match-case-.*').click()
    await page.getByTestId('resident-search-input').pressSequentially('ne+dle')
    await expect(page.getByTestId('search-match')).toHaveCount(2)

    // Turn it back off: the same text is now a literal phrase with a plus and matches nothing.
    await page.getByTestId('search-match-case-.*').click()
    await expect(page.getByTestId('search-match')).toHaveCount(0)
  })

  // §13.4 / D34 / D35: whole-word matching on UAX #29 boundaries. A partial-word occurrence must
  // NOT count — "needle" is not a word inside "needles" or "pineneedle".
  test('whole-word mode skips partial-word occurrences (D34/D35)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'words.md', 'needles and pineneedle here\n')

    await openSearchView(page)
    // Literal "needle" appears inside both words → two hits.
    await page.getByTestId('resident-search-input').pressSequentially('needle')
    await expect(page.getByTestId('search-match')).toHaveCount(2)

    // Whole-word: neither is a standalone word → zero hits.
    await page.getByTestId('search-match-case-ab').click()
    await expect(page.getByTestId('search-match')).toHaveCount(0)
  })

  // §13.4 / D35: ICU ships a dictionary for Han, so 中文 IS one word segment — whole-word
  // matching must work for Chinese, the exact bug the naive `\w`/`\p{L}` approaches get wrong.
  test('whole-word mode matches Chinese on UAX #29 boundaries (D35)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'cn.md', '这是中文文本，中文很重要\n')

    await openSearchView(page)
    await page.getByTestId('search-match-case-ab').click()
    // Both occurrences of 中文 are standalone word segments.
    await page.getByTestId('resident-search-input').pressSequentially('中文')
    await expect(page.getByTestId('search-match')).toHaveCount(2)
  })

  // §13.7 / D33: a regex that does not compile is a BLOCKING failure, not a silent fallback to
  // literal search. The user must see the inline diagnostic and get zero results.
  test('an invalid regex blocks the query with an inline diagnostic (D33)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'alpha.md', 'needle in alpha\n')

    await openSearchView(page)
    await page.getByTestId('search-match-case-.*').click()
    await page.getByTestId('resident-search-input').pressSequentially('(unclosed')

    // Fail-closed: the diagnostic is shown (role=alert) and no results leak through.
    await expect(page.getByTestId('search-diagnostic')).toBeVisible()
    await expect(page.getByTestId('search-match')).toHaveCount(0)
  })

  // §13.6 / D32 / D36: the literal two-character sequence `\n` expands to a line terminator, so a
  // regex can span lines; a literal `.` (regex) still does NOT match a newline.
  test('regex newline escape matches across lines, a literal dot does not (D32/D36)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openWorkspace(page)
    await importFile(page, 'cross.md', 'first\nsecond line\n')

    await openSearchView(page)
    await page.getByTestId('search-match-case-.*').click()
    // Single-line regex: `.` does not cross the newline → no hit.
    await page.getByTestId('resident-search-input').pressSequentially('first.second')
    await expect(page.getByTestId('search-match')).toHaveCount(0)

    // The `\n` escape spans the break: exactly one cross-line hit.
    await page.getByTestId('resident-search-input').fill('first\\nsecond')
    await expect(page.getByTestId('search-match')).toHaveCount(1)
  })
})
