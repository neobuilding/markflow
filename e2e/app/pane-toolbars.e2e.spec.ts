import { expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'
import { ALL_INLINE_AT, VIEWPORTS } from '../helpers/viewports'
import { expectTooltipText } from '../helpers/tooltip'
import { resetAppState } from '../helpers/reset'

// C20 / ADR-0024 §10 + ADR-0025 P2 (option B): the app has THREE bars — a re-scoped global bar
// (file commands), an editor pane bar (format / find-replace / undo-redo / read-only) and a
// preview pane bar (find / export / copy / copy rendered HTML / conditional More). In split mode
// each column carries its own bar, and the export entry point follows the preview's visibility:
// exactly ONE export button is ever on screen (trade-off 46 — two peer toolbars must not carry
// the same button side by side).
// Reuse ONE Electron instance (serial). These cases change viewport width and focus, so the
// shared `resetAppState` is essential: it restores the standard viewport and reloads the renderer.
test.describe.configure({ mode: 'serial' })
test.describe('pane toolbars', () => {
  let handle: AppHandle

  test.beforeAll(async () => {
    handle = await launchApp()
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })
  test.beforeEach(async () => {
    await resetAppState(handle)
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
    // environment the column is 368px wide: priority+ overflow keeps the high-priority format
    // cluster and Find inline, and moves the REST into one "…" menu one at a time as the column
    // shrinks (single overflow, no separate Format dropdown / minimal stage). The fully expanded
    // form has its own case below.
    await expect(page.getByTestId('editor-pane').getByTestId('editor-overflow-btn')).toBeVisible()
    await expect(page.getByTestId('editor-pane').getByTestId('fmt-**-**')).toHaveCount(1)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-find-btn')).toHaveCount(1)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-replace-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-undo-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-readonly-btn')).toHaveCount(0)

    // The preview column owns the preview-only actions. At 368px all four preview commands fit
    // inline (four 36px slots + 24px padding = 168px), so the CONDITIONAL overflow trigger is
    // absent:
    // no command — including Copy rendered HTML — may depend on that menu as its only entry point.
    await expect(page.getByTestId('preview-pane').getByTestId('preview-find-btn')).toBeVisible()
    await expect(page.getByTestId('preview-pane').getByTestId('preview-copy-btn')).toBeVisible()
    await expect(
      page.getByTestId('preview-pane').getByTestId('preview-copy-html-btn'),
    ).toBeVisible()
    await expect(page.getByTestId('preview-pane').getByTestId('preview-more-btn')).toHaveCount(0)

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
    // Its own case, because it needs its own window: every command is only inline when the COLUMN
    // is wide enough (below ALL_INLINE_AT they progressively move into "…"), and the column
    // is half the content area. The wide environment puts it at (1280 - sidebar 288) / 2 = 496 — see
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

  test('narrow editor column moves more commands into the overflow', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    // Narrow (800 content area) leaves each split column at (800 - 288) / 2 = 256px, well below
    // ALL_INLINE_AT: only the highest-priority format buttons remain inline, and the rest
    // have moved into one "…" overflow one at a time. There is no separate minimal stage.
    await page.setViewportSize(VIEWPORTS.narrow)
    await page.getByTestId('view-split').click()
    const editorBar = page.getByTestId('editor-pane-bar')
    // Guard the premise before asserting the result: boundingBox() is the border box == the column
    // width the app measures, so it must be < ALL_INLINE_AT for the overflow to be meaningful.
    await expect
      .poll(async () => (await editorBar.boundingBox())?.width ?? 0, {
        message: `the editor column must be narrow enough (< ${ALL_INLINE_AT}px) to overflow`,
      })
      .toBeLessThan(ALL_INLINE_AT)
    // The single overflow is present...
    await expect(page.getByTestId('editor-pane').getByTestId('editor-overflow-btn')).toBeVisible()
    // ...the low-priority actions moved into it, while the top-priority ones are STILL inline
    // (a progressive overflow, not an all-or-nothing fold).
    await expect(page.getByTestId('editor-pane').getByTestId('fmt-**-**')).toHaveCount(1)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-replace-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-undo-btn')).toHaveCount(0)
    await expect(page.getByTestId('editor-pane').getByTestId('editor-readonly-btn')).toHaveCount(0)
  })

  // The overflow is not just "one button instead of many": the commands that did NOT fit inline
  // must be inside it AND carry a visible label, while the rest stay on the bar. The old
  // two-stage model hid the seven formatting actions behind an UNLABELLED dropdown, so this
  // asserts the labels themselves, not just the presence of a trigger.
  test('the overflow holds the remaining commands with visible labels (priority+)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()

    await expect(page.getByTestId('editor-overflow-btn')).toBeVisible()
    await page.getByTestId('editor-overflow-btn').click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const labels = await menu.locator('[role="menuitem"]').allTextContents()
    // At the default 368px column the bar is PARTIALLY overflowed: some commands are still
    // inline, and only the low-priority ones live in the menu.
    expect(labels.length, 'a partially overflowed bar must have overflow entries').toBeGreaterThan(
      0,
    )
    expect(
      labels.length,
      'the overflow must not swallow the whole bar at a mid width',
    ).toBeLessThan(12)
    // Every entry names its action — no unlabelled glyph hides behind the overflow.
    for (const label of labels) {
      expect(label.trim(), 'an overflow entry must carry a visible label').not.toBe('')
    }
    // Inline buttons (minus the "…" trigger) + menu entries == all twelve commands: nothing
    // disappears when a command moves between the two placements.
    const inlineButtons = await page
      .getByTestId('editor-pane-bar')
      .locator('button[data-testid]')
      .count()
    expect(inlineButtons - 1 + labels.length, 'every command is inline or in the overflow').toBe(12)
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

    // With no document open the bar shows only what can act: Quick Open alone. Every
    // document-scoped command — Save / Save-As / Reload / file details / export / Close — is gated
    // on `activeDocumentId` (ADR-0024 §9, amended 2026-11-12: Close is gated too; with no document
    // there is nothing to close, so the button is hidden rather than left inert).
    await expect(globalBar.getByTestId('save-btn')).toHaveCount(0)
    await expect(globalBar.getByTestId('close-btn')).toHaveCount(0)
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
    // the column is partially overflowed and those low-priority commands live in the "…" menu,
    // so the buttons do not exist as buttons at all. The `wide` environment expands the bar.
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

  // ADR-0033: switching to preview-only UNMOUNTS the editor while the SAME document stays open.
  // A pending 400ms preview refresh must be flushed on teardown rather than discarded, or the
  // preview shows the pre-edit text. This is a different teardown path from a document switch.
  test('a preview-only switch inside the debounce window still shows the typed text', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'TYPED-BEFORE-SWITCH')
    // No wait: the click lands inside the 400ms window.
    await page.getByTestId('view-preview').click()
    await expect(page.locator('article.markdown-preview')).toContainText('TYPED-BEFORE-SWITCH')
  })

  test('a narrow preview column shows the conditional More with the overflowed commands', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    await expect(page.getByTestId('preview-more-btn')).toHaveCount(0)

    // Named environments bottom out at 256px per column, while four preview commands need only
    // 168px. Shrink the bar itself: the ResizeObserver observes THIS border box, so this takes
    // exactly the same measurement path as dragging the split divider to its narrowest ratio.
    await page.getByTestId('preview-pane-bar').evaluate((el) => {
      ;(el as HTMLElement).style.width = '120px'
    })
    await expect(page.getByTestId('preview-more-btn')).toBeVisible()
    await expect(page.getByTestId('preview-more-btn')).toHaveAttribute('aria-label', /.+/)
    await page.getByTestId('preview-more-btn').click()
    const menu = page.getByRole('menu')
    await expect(menu.getByTestId('preview-copy-html-btn')).toBeVisible()
    // 120px leaves one command inline; the other three are labelled entries in the overflow.
    await expect(menu.locator('[role="menuitem"]')).toHaveCount(3)
    await page.keyboard.press('Escape')
  })

  test('shrinking the column moves commands into More one at a time', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    const bar = page.getByTestId('editor-pane-bar')

    // Drive a CONTINUOUS shrink through the same ResizeObserver path the split divider uses.
    // Only inline command buttons carry data-command-index, so the count excludes the trigger.
    const counts = await bar.evaluate(async (el) => {
      const node = el as HTMLElement
      const result: number[] = []
      for (const width of [900, 460, 430, 400, 370, 340, 310, 280, 250, 220]) {
        node.style.width = `${width}px`
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        result.push(node.querySelectorAll('button[data-command-index]').length)
      }
      node.style.width = ''
      return result
    })

    expect(counts[0]).toBe(12)
    // Many distinct intermediate states, never an all-or-nothing jump.
    expect(new Set(counts).size).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i], `width step ${i} never expands while shrinking`).toBeLessThanOrEqual(
        counts[i - 1],
      )
      // The last geometric step restores two commands (trigger + final command); no other step
      // may move more than one.
      expect(counts[i - 1] - counts[i], `width step ${i} folds one at a time`).toBeLessThanOrEqual(
        2,
      )
    }
  })

  test('folding a focused command keeps keyboard focus reachable (WCAG 2.4.3)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    const bar = page.getByTestId('editor-pane-bar')
    const activeId = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

    await page.getByTestId('fmt-# -').focus()
    await bar.evaluate((el) => {
      ;(el as HTMLElement).style.width = '60px'
    })
    await expect.poll(activeId).toBe('editor-overflow-btn')

    // Back to the default 368px column the bar is still PARTIALLY overflowed (More stays), so
    // expand past ALL_INLINE_AT to make the trigger disappear and hand focus back inline.
    await bar.evaluate((el) => {
      ;(el as HTMLElement).style.width = '900px'
    })
    await expect.poll(activeId).toBe('fmt-# -')
  })

  // A focus OUTSIDE the bar (the editor caret) must NOT be pulled into the toolbar when a command
  // folds. useOverflowFocus only re-homes focus that is ALREADY inside the bar; a STALE in-bar focus
  // (the user focused a command, then moved the caret to the editor) must not yank it back when the
  // column narrows. Locked at the real-browser level because jsdom cannot reproduce CodeMirror's
  // focus management. See docs/agents/testing.md "Regression tests must be able to fail".
  test('a focus in the editor pane is not pulled into the toolbar when a command folds', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'CARET-HERE')
    const editor = page.locator('.cm-content')
    const bar = page.getByTestId('editor-pane-bar')

    // Focus a command that WILL be folded: the undo button sits at the tail of the priority
    // order, so it is among the first to move into "…". It has to be INLINE for this to be
    // reachable at all, hence the wide bar first.
    await bar.evaluate((el, w) => {
      ;(el as HTMLElement).style.width = `${w}px`
    }, 900)
    const undo = page.getByTestId('editor-undo-btn')
    await expect(undo).toBeVisible()
    await undo.focus()
    await expect(undo).toBeFocused()

    // The user then moves the caret back into the editor pane, so the bar's tracked focus is now
    // STALE: the command it remembers is no longer where the focus is.
    await editor.click()
    await expect(editor).toBeFocused()

    // Narrow the column so that very command is folded away. The guard must leave the caret alone.
    await bar.evaluate((el, w) => {
      ;(el as HTMLElement).style.width = `${w}px`
    }, 200)
    await expect(undo).toHaveCount(0)
    await expect(editor).toBeFocused()
  })

  // The chrome budget is a MODEL of the rendered bar. If the DOM charges more than the budget
  // (a separator, a border, a gap), the bar would claim to be fully inline while clipping its
  // last command. `e2e/guards/viewports.test.ts` re-derives the threshold from the budget but
  // cannot see layout; THIS case is the only one that measures the real bar against that model.
  test('the all-inline width really fits the rendered bar (no clipped command)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'hello world')
    const bar = page.getByTestId('editor-pane-bar')

    await bar.evaluate((el, w) => {
      ;(el as HTMLElement).style.width = `${w}px`
    }, ALL_INLINE_AT)
    const fit = await bar.evaluate((el) => {
      const node = el as HTMLElement
      return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
    })
    // Guard the premise: the width really took effect, so the fit assertion below is not vacuous.
    expect(fit.clientWidth, 'the bar took the requested width').toBe(ALL_INLINE_AT)
    expect(
      fit.scrollWidth,
      `the rendered bar (${fit.scrollWidth}px of content) must fit the width the budget claims for it (${fit.clientWidth}px)`,
    ).toBeLessThanOrEqual(fit.clientWidth)

    // The ResizeObserver drives the re-render; every command must be inline at that width.
    await expect
      .poll(async () =>
        bar.evaluate((el) => el.querySelectorAll('button[data-command-index]').length),
      )
      .toBe(12)

    // One pixel less and the bar must give a command up — otherwise the width above was a lie.
    await bar.evaluate((el, w) => {
      ;(el as HTMLElement).style.width = `${w}px`
    }, ALL_INLINE_AT - 1)
    await expect
      .poll(async () =>
        bar.evaluate((el) => el.querySelectorAll('button[data-command-index]').length),
      )
      .toBeLessThan(12)
  })

  // R5 plan A: no standalone print preview window — the user watches the MAIN window's own
  // preview pane. That window must NOT be whole-window disabled (setEnabled(false) would freeze
  // the preview), so blocking is FINE-GRAINED: the editor goes read-only, every file/document
  // shortcut is refused, and the renderer draws no overlay, while the preview stays reachable.
  // This drives the printing flag directly (a real OS print dialog cannot be driven from a test).
  test('printing locks the document but leaves the main window preview usable (R5 plan A)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'print me')
    await page.getByTestId('view-split').click()

    const preview = page.getByTestId('preview-pane')
    await expect(preview).toBeVisible()
    const box = (await preview.boundingBox())!
    const editorContent = page.locator('.cm-content')

    // Enter edit mode explicitly so the read-only transition is observable in the DOM.
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
    await expect(editorContent).toHaveAttribute('contenteditable', 'true')
    const idBefore = await page.evaluate(
      () => (window as any).__uiStore.getState().activeDocumentId,
    )

    await page.evaluate(() => (window as any).__uiStore.getState().setPrinting(true))
    // The non-blocking indicator lives in the status bar, not over the content.
    await expect(page.getByText(/Printing/)).toBeVisible()

    // 1. Editor is read-only for the duration of the print transaction.
    await expect(editorContent).toHaveAttribute('contenteditable', 'false')

    // 2. The preview pane is still hit-testable: no overlay, and no OS-level window disable.
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="preview-pane"]') !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    )
    expect(hit, 'a full-screen overlay must not sit between the pointer and the preview').toBe(true)

    // 3. File shortcuts are refused by the print-mode lock (renderer keydown guard, store guard
    //    and the native menu accelerators that send menu events all have to agree).
    await page.keyboard.press('Control+n')
    await page.keyboard.press('Control+w')
    expect(
      await page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId),
      'Ctrl+N/Ctrl+W must not create or close a document while printing',
    ).toBe(idBefore)

    // Ending printing restores the previous edit mode — no permanent state damage.
    await page.evaluate(() => (window as any).__uiStore.getState().setPrinting(false))
    await expect(editorContent).toHaveAttribute('contenteditable', 'true')
  })

  // User report 2026-11-13: "the main window disables many features…but these toolbar buttons are still not disabled". The store
  // guard and the NATIVE menu already stood down, but the three toolbars kept rendering enabled
  // buttons that silently did nothing. A disabled ACTION must look disabled, and must come back
  // when the print window closes. Read-only affordances (view mode, find, copy) stay available —
  // the preview is meant to remain scrollable while the system dialog is up (R5 plan A).
  test('printing visibly disables the locked controls on all three toolbars', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createDocAndType(page, 'locked')
    await page.getByTestId('view-edit').click()
    await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))

    const globalBar = [
      'editor-goto-file-btn',
      'new-document-btn',
      'save-btn',
      'save-as-btn',
      'reload-btn',
      'file-details-btn',
      'close-btn',
      'export-btn',
    ]
    const editorBar = [
      'editor-readonly-btn',
      'editor-replace-btn',
      'editor-undo-btn',
      'editor-redo-btn',
    ]

    const disabledOf = async (id: string): Promise<string> => {
      const btn = page.getByTestId(id)
      if ((await btn.count()) === 0) return 'absent'
      return (await btn.isDisabled()) ? 'disabled' : 'ENABLED'
    }

    try {
      await page.evaluate(() => (window as any).__uiStore.getState().setPrinting(true))

      for (const id of [...globalBar, ...editorBar]) {
        expect(await disabledOf(id), `${id} must be disabled while printing`).toBe('disabled')
      }
      const fmtButtons = await page.locator('[data-testid^="fmt-"]').all()
      expect(
        fmtButtons.length,
        'the format buttons must be rendered inline in edit-only mode',
      ).toBe(7)
      for (const btn of fmtButtons) {
        expect(
          await btn.isDisabled(),
          `${await btn.getAttribute('data-testid')} must be disabled while printing`,
        ).toBe(true)
      }
      // Still usable: view switching and find do not mutate the document.
      for (const id of ['view-edit', 'view-split', 'view-preview', 'editor-find-btn']) {
        expect(await disabledOf(id), `${id} must stay available during printing`).toBe('ENABLED')
      }

      // The preview bar carries the export button when the preview is visible.
      await page.getByTestId('view-split').click()
      expect(await disabledOf('export-btn'), 'preview-bar export must be disabled').toBe('disabled')
      for (const id of ['preview-find-btn', 'preview-copy-btn', 'preview-copy-html-btn']) {
        expect(await disabledOf(id), `${id} must stay available during printing`).toBe('ENABLED')
      }

      // Closing the print window restores every one of them (no permanent lock).
      await page.evaluate(() => (window as any).__uiStore.getState().setPrinting(false))
      for (const id of [
        'reload-btn',
        'file-details-btn',
        'close-btn',
        'export-btn',
        'preview-copy-btn',
      ]) {
        expect(await disabledOf(id), `${id} must be enabled again after printing`).toBe('ENABLED')
      }
      await page.getByTestId('view-edit').click()
      for (const id of ['editor-readonly-btn', 'editor-replace-btn', 'export-btn']) {
        expect(await disabledOf(id), `${id} must be enabled again after printing`).toBe('ENABLED')
      }
    } finally {
      await page.evaluate(() => (window as any).__uiStore.getState().setPrinting(false))
    }
  })
})
