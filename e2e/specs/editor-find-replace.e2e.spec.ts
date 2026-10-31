import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// Editor find/replace is now powered by MarkFlow's shared FindWidget (top-anchored, VS Code
// style) instead of CodeMirror's native panel. The entry points (`Ctrl/Cmd+H` and the toolbar
// button) still open it via `openSearchPanel`. The FindWidget's DOM is identified by testids:
// `editor-find-input`, `editor-find-replace`, `editor-find-count-next` (next), `editor-find-replace-btn`
// (replace current). The preview pane is read-only and never offers replace, but has its own
// find bar (`preview-find-*`), covered here too.
test.describe('find and replace', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
    await expect(page.locator('.cm-content')).toContainText(text)
  }

  test('Ctrl+H opens the search panel with a replace field', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+H`)

    const panel = page.getByTestId('editor-find')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('editor-find-input')).toBeVisible()
    await expect(page.getByTestId('editor-find-replace')).toBeVisible()
    // Both find surfaces share one floating "card" class (ADR-0023): the editor panel is a
    // CodeMirror top-panel styled as `.find-surface`, not an inline strip.
    await expect(page.locator('.cm-panels-top .find-surface').first()).toBeVisible()
    // One shortcut, ONE owner: the sidebar's "search in files" view must stay closed. The app
    // shell used to claim Ctrl+H for that view from a capture-phase listener that stops the
    // event, which silently stole the key from the editor's replace panel (the Search view
    // opened instead, and the editor's panel never appeared).
    await expect(page.getByTestId('resident-search-input')).toBeHidden()
    await expect(page.getByTestId('activity-bar-search')).toHaveAttribute('aria-selected', 'false')
  })

  test('the toolbar replace button opens the same panel', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    await page.getByTestId('editor-replace-btn').click()

    await expect(page.getByTestId('editor-find')).toBeVisible()
    await expect(page.getByTestId('editor-find-replace')).toBeVisible()
  })

  test('Replace swaps the matched text in the document', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    await page.getByTestId('editor-replace-btn').click()
    const panel = page.getByTestId('editor-find')
    await expect(panel).toBeVisible()

    // The FindWidget commits the query on every input event, so typing into the fields is enough.
    await page.getByTestId('editor-find-input').pressSequentially('world')
    await page.getByTestId('editor-find-replace').pressSequentially('earth')
    // `replaceCurrentMatch` only rewrites the CURRENT match: move onto it first (`next`), then replace.
    await page.getByTestId('editor-find-count-next').click()
    await page.getByTestId('editor-find-replace-btn').click()

    await expect(page.locator('.cm-content')).toContainText('hello earth')
    await expect(page.locator('.cm-content')).not.toContainText('world')
  })

  test('preview find bar highlights the current match in the rendered preview', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    // The preview renders off-thread with a ~150ms debounce. Wait for it to settle BEFORE
    // searching: the find bar searches once per query change, so searching stale content
    // would leave zero marks even after the preview catches up.
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    await page.getByTestId('preview-find-btn').click()
    await expect(page.getByTestId('preview-find-bar')).toBeVisible()
    // Same floating surface as the editor find widget (one visual language). `find-surface` is a
    // CSS class on the element (its `data-testid` is `preview-find-bar`), so assert the class.
    await expect(page.getByTestId('preview-find-bar')).toHaveClass(/find-surface/)

    await page.getByTestId('preview-find-input').pressSequentially('hello')
    // Exactly one match, and it is flagged as the current (active) match.
    await expect(page.locator('mark.preview-find-match')).toHaveCount(1)
    await expect(page.locator('mark.preview-find-active')).toHaveCount(1)
    // The k/n counter comes from the marks we insert into the preview DOM — external data the
    // component reads through useSyncExternalStore. Assert it in the real app (jsdom coverage
    // alone would not prove the store publishes correctly outside a test renderer).
    await expect(page.getByTestId('preview-find-count')).toContainText('1 / 1')
  })

  test('preview find keeps its k/n counter in sync when the query narrows', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world hello again')
    await expect(page.locator('article.markdown-preview')).toContainText('hello world hello again')

    await page.getByTestId('preview-find-btn').click()
    await page.getByTestId('preview-find-input').pressSequentially('hello')
    await expect(page.getByTestId('preview-find-count')).toContainText('1 / 2')
    // Narrow to the second occurrence only: the counter must re-publish, not stay stale.
    await page.getByTestId('preview-find-input').fill('again')
    await expect(page.getByTestId('preview-find-count')).toContainText('1 / 1')
  })

  test('Ctrl+F opens the editor find panel even when the editor has no focus', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    // Blur everything: this is precisely the state in which Ctrl+F used to do NOTHING, because the
    // shortcut lived only in CodeMirror's `searchKeymap` and that fires solely while the editor
    // content itself holds focus. Clicking the sidebar, the title bar or the preview killed it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+F`)

    await expect(page.getByTestId('editor-find')).toBeVisible()
    // The panel must own the keyboard too: CodeMirror's own focus of `[main-field]` runs before
    // React has committed the input, so without the explicit focus the query is typed into the
    // document and the panel looks like it "did nothing".
    await expect(page.getByTestId('editor-find-input')).toBeFocused()
  })

  test('Ctrl+F opens find-only — no replace field (VS Code parity with Ctrl+H)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+F`)

    await expect(page.getByTestId('editor-find')).toBeVisible()
    // Ctrl/Cmd+F is the find-only shortcut: the replace row must stay hidden (it appears only on
    // Ctrl/Cmd+H or the toolbar replace button). Guards against the two shortcuts collapsing into the
    // same panel — the deviation first spotted during the review.
    await expect(page.getByTestId('editor-find-replace')).toBeHidden()

    // re-open path, with the focus where real users have it: the panel opened above put focus
    // in the find input, so these presses ride the panel's own listeners (createPanel only runs on
    // the first open) AND require the cm-panel fields to be exempt from the G5 editable guard.
    await page.keyboard.press(`${mod}+H`)
    await expect(page.getByTestId('editor-find-replace')).toBeVisible()
    await page.keyboard.press(`${mod}+F`)
    await expect(page.getByTestId('editor-find-replace')).toBeHidden()
  })

  test('Ctrl+F in preview mode opens the preview find bar', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    // Preview-only: there is no editor to route to.
    await page.getByTestId('view-preview').click()
    await expect(page.getByTestId('editor-find-btn')).toBeHidden()

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+F`)

    await expect(page.getByTestId('preview-find-bar')).toBeVisible()
    await expect(page.getByTestId('preview-find-input')).toBeFocused()
  })

  test('in split mode, Ctrl+F follows the pane the user last interacted with', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    // Split view: BOTH panes are visible. The preview is a non-focusable <div>, so neither focus
    // nor viewMode alone can identify the active pane; routing by viewMode alone sent Ctrl+F to the
    // editor's find even while the user was clicking in the preview (the reported bug). The two
    // surfaces search different text (rendered preview vs markdown source), so the target matters.
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    await expect(page.getByTestId('preview-pane')).toBeVisible()

    // Click the PREVIEW pane, then Ctrl+F -> the PREVIEW find.
    await page.getByTestId('preview-pane').click()
    await page.keyboard.press(`${mod}+F`)
    await expect(page.getByTestId('preview-find-bar')).toBeVisible()
    await expect(page.getByTestId('editor-find')).toBeHidden()

    // Close it, touch the EDITOR pane, and Ctrl+F must now go to the editor's find.
    await page.getByTestId('preview-find-close').click()
    await page.getByTestId('editor-pane').click()
    await page.keyboard.press(`${mod}+F`)
    await expect(page.getByTestId('editor-find')).toBeVisible()
    await expect(page.getByTestId('preview-find-bar')).toBeHidden()
  })

  test('in split mode, Ctrl+H follows the same pane routing as Ctrl+F', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('preview-pane')).toBeVisible()

    // The preview has no replace field, so while it is the active pane Ctrl+H must NOT drag the user
    // across to the editor's replace panel — same pane-routing rule (and the same "don't take a key
    // that isn't yours" stand-down) as Ctrl+F. Regression guard: the G4 fix only exercised
    // pure-preview mode, leaving this cell hijacking the key to the editor.
    await page.getByTestId('preview-pane').click()
    await page.keyboard.press(`${mod}+H`)
    await expect(page.getByTestId('editor-find')).toBeHidden()
    await expect(page.getByTestId('preview-find-bar')).toBeHidden()

    // Touching the editor pane hands Ctrl+H back to it, and it opens in replace mode.
    await page.getByTestId('editor-pane').click()
    await page.keyboard.press(`${mod}+H`)
    await expect(page.getByTestId('editor-find')).toBeVisible()
    await expect(page.getByTestId('editor-find-replace')).toBeVisible()
  })

  test('Ctrl+F stands down while a modal surface owns the keyboard', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    // 1) A real Radix dialog. Opened through the store so the test does not depend on whether the
    // Ctrl+N accelerator reaches the renderer — the action under test is still a real key press.
    await page.evaluate(() => (window as any).__uiStore.getState().setNewDocOpen(true))
    await expect(page.getByTestId('new-document-dialog')).toBeVisible()
    await page.keyboard.press(`${mod}+F`)
    // No find panel may be opened hidden behind the dialog (the reported bug).
    await expect(page.getByTestId('editor-find')).toBeHidden()

    // The other window-level shortcuts stand down here too: the palette must not be stacked on top
    // of the open dialog, and Ctrl+N must not open a SECOND dialog behind the first.
    await page.keyboard.press(`${mod}+K`)
    await expect(page.getByTestId('search-input')).toBeHidden()
    await page.keyboard.press(`${mod}+N`)
    await expect(page.getByTestId('new-document-dialog')).toHaveCount(1)

    // Closing the dialog hands the keyboard back, and the shortcut works again.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('new-document-dialog')).toBeHidden()
    await page.getByTestId('editor-pane').click()
    await page.keyboard.press(`${mod}+F`)
    await expect(page.getByTestId('editor-find')).toBeVisible()

    // 2) The command palette: not a Radix dialog, it opts in via data-modal-surface.
    await page.keyboard.press('Escape') // close the find panel again
    await expect(page.getByTestId('editor-find')).toBeHidden()
    await page.evaluate(() => (window as any).__uiStore.getState().setSearchOpen(true))
    await expect(page.getByTestId('search-input')).toBeVisible()
    // The guard can only work if the palette actually opts in: assert the marker is really in the
    // DOM, not merely present in the source. Without this the test could pass for the wrong reason.
    await expect(page.locator('[data-modal-surface]')).toHaveCount(1)
    await page.keyboard.press(`${mod}+F`)
    // Still no find panel — and the palette itself was left undisturbed.
    await expect(page.getByTestId('editor-find')).toBeHidden()
    await expect(page.getByTestId('search-input')).toBeVisible()
  })

  test('the preview find button stays reachable at the top of the pane instead of being clipped', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')
    await page.getByTestId('view-preview').click()

    const button = page.getByTestId('preview-find-btn')
    await expect(button).toBeVisible()

    // Regression: as a flow element following an `h-full` content div inside an `overflow-hidden`
    // parent, the button was laid out BELOW the visible area and clipped away — the pane had no
    // reachable search button at all. `click()` never caught it because a clipped element still
    // has a bounding box, so only geometry does: the button must sit near the TOP of the pane.
    //
    // C20 moved the button from the floating widget into the preview pane bar (ADR-0025 §5 P2.2),
    // so the bar is now its host — and the same "reachable, not clipped" guarantee must hold.
    const geometry = await button.evaluate((el) => {
      const host = el.parentElement
      const own = el.getBoundingClientRect()
      const hostRect = host?.getBoundingClientRect()
      return {
        offsetFromHostTop: own.top - (hostRect?.top ?? 0),
        hostHeight: hostRect?.height ?? 0,
      }
    })
    expect(geometry.offsetFromHostTop).toBeGreaterThanOrEqual(0)
    expect(geometry.offsetFromHostTop).toBeLessThan(60)
    // It must also be within the pane, not parked underneath it.
    expect(geometry.offsetFromHostTop).toBeLessThan(geometry.hostHeight)
  })

  test('preview find highlights matches inside a formula and skips the hidden MathML copy', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('math $E = mc^2$ and mc again')
    await expect(page.locator('.cm-content')).toContainText('again')
    await expect(page.locator('article.markdown-preview .katex')).toBeVisible()

    await page.getByTestId('preview-find-btn').click()
    await page.getByTestId('preview-find-input').pressSequentially('mc')

    // Two VISIBLE matches: the formula and the plain text. KaTeX renders every formula twice, and
    // the hidden MathML copy used to be counted as a third, invisible match that next/prev would
    // scroll to — "1 / 3" pointing at nothing.
    await expect(page.getByTestId('preview-find-count')).toContainText('1 / 2')
    await expect(page.locator('.katex-mathml mark')).toHaveCount(0)
    // The formula's visible half is highlighted even though KaTeX emits one span per character, so
    // a per-text-node search could never find "mc" there.
    await expect(page.locator('.katex-html mark.preview-find-match')).toHaveCount(2)
  })
})
