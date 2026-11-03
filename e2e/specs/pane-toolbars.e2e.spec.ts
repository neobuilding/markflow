import { expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'
import { VIEWPORTS } from '../helpers/viewports'
import { expectTooltipText } from '../helpers/tooltip'
import {
  expectClipboardAfter,
  readClipboardText,
  snapshotClipboard,
  restoreClipboard,
  clipboardSkipMessage,
  CLIPBOARD_SPEC_SKIP_REASON,
  type ClipboardSnapshot,
} from '../helpers/clipboard'

// C20 / ADR-0024 §10 + ADR-0025 P2 (方案乙): the app has THREE bars — a re-scoped global bar
// (file commands), an editor pane bar (format / find-replace / undo-redo / read-only) and a
// preview pane bar (find / export / copy / more). In split mode each column carries its own bar,
// and the export entry point follows the preview's visibility: exactly ONE export button is ever
// on screen (trade-off 46 — two peer toolbars must not carry the same button side by side).
test.describe('pane toolbars', () => {
  let handle: AppHandle
  // The copy test writes the REAL system clipboard. Snapshot it first so afterEach restores the
  // user's own content; when it cannot be restored the test skips instead of destroying it. The
  // snapshot is only taken when clipboard specs run here, so a normal local run writes nothing
  // (see helpers/clipboard).
  let snap: ClipboardSnapshot | undefined
  test.beforeEach(async ({ clipboardE2e }) => {
    handle = await launchApp()
    snap = clipboardE2e ? await snapshotClipboard(handle) : undefined
  })
  test.afterEach(async () => {
    await restoreClipboard(handle, snap)
    await closeApp(handle)
  })

  async function createDocAndType(page: Page, text: string): Promise<void> {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
    await expect(page.locator('.cm-content')).toContainText(text)
  }

  test('split mode gives each column its own bar, and the global bar keeps the file commands', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    await expect(page.getByTestId('preview-pane')).toBeVisible()

    // The editor column owns the editor-only clusters (ADR-0024 §10 trade-off 52). In the default
    // environment the column is 368px wide, so EVERYTHING collapses into one "…" overflow
    // (Q3: single overflow, no separate Format dropdown / minimal stage); the expanded form has its
    // own case below.
    await expect(page.getByTestId('editor-pane').getByTestId('editor-overflow-btn')).toBeVisible()
    // The individual actions are no longer inline — they moved one level down into the overflow.
    await expect(page.getByTestId('editor-pane').getByTestId('fmt-**-**')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-find-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-replace-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-undo-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-readonly-btn')).toHaveCount(0)

    // The preview column owns the preview-only actions.
    await expect(page.getByTestId('preview-pane').getByTestId('preview-find-btn')).toBeVisible()
    await expect(page.getByTestId('preview-pane').getByTestId('preview-copy-btn')).toBeVisible()
    await expect(page.getByTestId('preview-pane').getByTestId('preview-more-btn')).toBeVisible()

    // The global bar keeps the file-lifecycle commands (trade-off 50 / 51 / 53): they must stay
    // reachable in every view mode, which only the always-mounted global bar can guarantee.
    await expect(page.getByTestId('save-btn')).toBeVisible()
    await expect(page.getByTestId('reload-btn')).toBeVisible()
    await expect(page.getByTestId('file-details-btn')).toBeVisible()

    // The editor-only cluster lives ONCE: it sank out of the global bar instead of being duplicated,
    // and now sits in a single overflow button inside the editor column.
    await expect(page.getByTestId('editor-overflow-btn')).toHaveCount(1)
    // The global bar must NOT carry an editor overflow of its own.
    await expect(
      page.locator('[data-testid="global-bar"]').getByTestId('editor-overflow-btn'),
    ).toHaveCount(0)
  })

  test('a wide editor column expands the format cluster into its seven entries', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Its own case, because it needs its own window: the cluster only expands when the COLUMN is
    // wide enough (EditorPaneBar folds it below FOLD_AT = 420), and the column is half the content
    // area. The wide environment puts it at (1280 - sidebar 288) / 2 = 496 — see
    // e2e/helpers/viewports.ts for the arithmetic, and e2e/guards/viewports.test.ts for the
    // contract that keeps the two numbers in sync with the app's own constants.
    await page.setViewportSize(VIEWPORTS.wide)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()

    // The seven format entries (heading, bold, italic, code, link, list, task) sit inline.
    await expect(page.getByTestId('editor-pane').getByTestId(/^fmt-/)).toHaveCount(7)
    await expect(page.getByTestId('editor-pane').getByTestId('fmt-**-**')).toBeVisible()
    // The single overflow is replaced by the expanded actions, never shown alongside them.
    await expect(page.getByTestId('editor-overflow-btn')).toHaveCount(0)
    // And the cluster lives in the editor column only — the global bar does not carry a copy.
    await expect(page.getByTestId(/^fmt-/)).toHaveCount(7)
  })

  test('narrow editor column folds everything into a single overflow', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    // Narrow (800 content area) leaves each split column at (800 - 288) / 2 = 256px, which is below
    // FOLD_AT (420) — the single fold threshold. Q3 removed the old minimal stage, so the WHOLE bar
    // (format + find/replace + undo/redo/read-only) collapses into one "…" overflow.
    await page.setViewportSize(VIEWPORTS.narrow)
    await page.getByTestId('view-split').click()
    const editorBar = page.getByTestId('editor-pane-bar')
    // Guard the premise before asserting the result: boundingBox() is the border box == the column
    // width the app measures, so it must be < FOLD_AT for the fold to be meaningful.
    await expect
      .poll(async () => (await editorBar.boundingBox())?.width ?? 0, {
        message: 'the editor column must be narrow enough (< 420px) to fold',
      })
      .toBeLessThan(420)
    // Everything collapses into the single overflow...
    await expect(page.getByTestId('editor-pane').getByTestId('editor-overflow-btn')).toBeVisible()
    // ...and the individual actions are no longer inline.
    await expect(page.getByTestId('editor-pane').getByTestId('fmt-**-**')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-undo-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-readonly-btn')).toHaveCount(0)
  })

  // The single overflow is not just "one button instead of many": EVERY command must be inside it
  // AND carry a visible label. The old two-stage model hid the seven formatting actions behind an
  // UNLABELLED dropdown, so this asserts the labels themselves, not just the presence of a trigger.
  test('the folded overflow holds every command with a visible label (Q3)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()

    await expect(page.getByTestId('editor-overflow-btn')).toBeVisible()
    await page.getByTestId('editor-overflow-btn').click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    // Seven format actions + find + replace + undo + redo + read-only = twelve entries.
    await expect(menu.locator('[data-testid^="fmt-"]')).toHaveCount(7)
    for (const id of [
      'editor-find-btn',
      'editor-replace-btn',
      'editor-undo-btn',
      'editor-redo-btn',
      'editor-readonly-btn',
    ]) {
      await expect(menu.getByTestId(id)).toBeVisible()
    }
    // Every entry names its action — no unlabelled glyph hides behind the overflow.
    const labels = await menu.locator('[role="menuitem"]').allTextContents()
    expect(labels).toHaveLength(12)
    for (const label of labels) {
      expect(label.trim(), 'an overflow entry must carry a visible label').not.toBe('')
    }
  })

  // The read-only toggle is a toggle BUTTON in the wide bar: its pressed state says which mode is
  // active, and its accessible name states the CURRENT mode (the tooltip states the action).
  // Edit is the pressed one; read-only is the resting one (ADR-0029).
  test('the read-only toggle states the current mode and its pressed state (Q1)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Its own case: the toggle is inline only in the expanded bar (wide environment).
    await page.setViewportSize(VIEWPORTS.wide)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()

    const toggle = page.getByTestId('editor-readonly-btn')
    await expect(toggle).toBeVisible()
    // A new draft opens in EDIT mode, so the toggle is pressed and says so.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle).toHaveAttribute('aria-label', 'Edit')

    // Clicking switches to read-only: the pressed state follows, and the name states the new mode.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAttribute('aria-label', 'Read-only')
  })

  // EVERY format action advertises its shortcut (ADR-0032) — the toolbar is no longer a
  // mouse-only surface, and a shortcut nobody can see is a shortcut nobody finds. The glyph is
  // platform-formatted like every other shortcut label in the app (Ctrl+B off macOS).
  // This subsumes the original Bold-only assertion (Q2c) and extends it to the whole cluster.
  test('every format button advertises its shortcut in the tooltip', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.setViewportSize(VIEWPORTS.wide)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()

    const mac = process.platform === 'darwin'
    const cases: Array<[string, string]> = [
      ['fmt-# -', mac ? '⌘1' : 'Ctrl+1'],
      ['fmt-**-**', mac ? '⌘B' : 'Ctrl+B'],
      ['fmt-_-_', mac ? '⌘I' : 'Ctrl+I'],
      ['fmt-`-`', mac ? '⌘E' : 'Ctrl+E'],
      ['fmt-[-](url)', mac ? '⌘K' : 'Ctrl+K'],
      ['fmt-- -', mac ? '⌘⇧L' : 'Ctrl+Shift+L'],
      ['fmt-- [ ] -', mac ? '⌘⇧T' : 'Ctrl+Shift+T'],
    ]
    for (const [testId, glyph] of cases) {
      await expectTooltipText(page, testId, glyph)
    }
  })

  // The two relocated app commands advertise their NEW chords (ADR-0032). A stale glyph points at
  // a key that does something else, which is worse than no glyph at all.
  test('the global bar advertises the relocated chords ⌘⇧K and ⌘⇧I', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    const mac = process.platform === 'darwin'
    await expectTooltipText(page, 'editor-goto-file-btn', mac ? '⌘⇧K' : 'Ctrl+Shift+K')
    await expectTooltipText(page, 'file-details-btn', mac ? '⌘⇧I' : 'Ctrl+Shift+I')
  })

  // The extracted global toolbar (Q8) owns the APP-level commands, and the sidebar toggle that
  // used to live here was removed (Q2a): the content panel is folded from the activity-bar menu,
  // the native View menu or ⌘\.
  test('the global bar carries the app commands and no sidebar toggle (Q2a/Q8)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const globalBar = page.getByTestId('global-bar')
    await expect(globalBar).toBeVisible()
    // Quick Open is the first entry of the global toolbar.
    await expect(globalBar.getByTestId('editor-goto-file-btn')).toBeVisible()
    // The sidebar toggle is gone from this bar.
    await expect(page.getByTestId('sidebar-toggle-btn')).toHaveCount(0)

    // With no document open the bar shows only what can act (Quick Open + Close) — ADR-0024 §9.
    await expect(globalBar.getByTestId('save-btn')).toHaveCount(0)
    await expect(globalBar.getByTestId('close-btn')).toBeVisible()
  })

  test('the export button follows the preview visibility — exactly one is on screen', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')

    // Edit-only: there is no visible preview to inspect, so the entry point stays on the global bar.
    await page.getByTestId('view-edit').click()
    await expect(page.getByTestId('export-btn')).toHaveCount(1)
    await expect(page.getByTestId('preview-pane').getByTestId('export-btn')).toHaveCount(0)

    // Preview visible: the action sits next to the live rendering it exports.
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('export-btn')).toHaveCount(1)
    await expect(page.getByTestId('preview-pane').getByTestId('export-btn')).toHaveCount(1)
  })

  test('the editor pane bar undo/redo track the document history', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Its own case: undo / redo are INLINE only in the expanded bar. In the default environment
    // the column is folded and Q3 moved every command into the single "…" overflow, so the buttons
    // do not exist as buttons at all. The `wide` environment expands the bar.
    await page.setViewportSize(VIEWPORTS.wide)
    await createDocAndType(page, 'hello world')

    const undo = page.getByTestId('editor-undo-btn')
    const redo = page.getByTestId('editor-redo-btn')
    // Typing produced history, so undo is available and redo is not.
    await expect(undo).toBeEnabled()
    await expect(redo).toBeDisabled()

    await undo.click()
    // Undo reverts the typed burst (CodeMirror groups it by origin, so assert the change, not
    // the exact grouping).
    await expect(page.locator('.cm-content')).not.toContainText('hello world')
    await expect(redo).toBeEnabled()

    await redo.click()
    await expect(page.locator('.cm-content')).toContainText('hello world')
  })

  test('the preview find panel is anchored inside the preview pane bar, not a floating widget', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-preview').click()
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    // ONE find entry point: the toolbar button. The standalone floating PreviewFindBar widget was
    // removed (ADR-0025 §5 P2.2), so there is no second, floating copy of the button.
    await expect(page.getByTestId('preview-find-btn')).toHaveCount(1)
    await page.getByTestId('preview-find-btn').click()

    // The panel lives INSIDE the preview pane (anchored under the pane bar) and keeps the shared
    // `find-surface` class, so both find surfaces look alike.
    const panel = page.getByTestId('preview-pane').getByTestId('preview-find-bar')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveClass(/find-surface/)
    await expect(page.getByTestId('preview-find-input')).toBeFocused()
  })

  test('the preview bar copies the rendered content to the system clipboard', async ({
    clipboardE2e,
  }) => {
    // Destructive: runs in the e2e-clipboard project only (see helpers/clipboard.ts).
    test.skip(!clipboardE2e, CLIPBOARD_SPEC_SKIP_REASON)
    // Never overwrite a clipboard we cannot put back.
    test.skip(!snap?.restorable, clipboardSkipMessage(snap))
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await expect(page.locator('article.markdown-preview')).toContainText('hello world')

    // The bar reuses the ONE rich-copy implementation (previewCopy.requestRichCopy), which selects
    // the whole article when nothing is selected — so the clipboard carries the rendered text.
    await expectClipboardAfter(
      handle,
      () => page.getByTestId('preview-copy-btn').click(),
      () => readClipboardText(handle),
      'hello world',
    )
  })
})
