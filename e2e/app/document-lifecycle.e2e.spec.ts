import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  waitForAppReady,
  closeApp,
  installConfirmSpy,
  getConfirmCalls,
  AppHandle,
} from '../helpers/launch'
import { VIEWPORTS } from '../helpers/viewports'
import { resetAppState } from '../helpers/reset'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// Reuse ONE Electron instance (serial) instead of launching per case; `resetAppState` restores
// both processes between cases so drafts, viewport, workspace root and store flags cannot leak.
test.describe.configure({ mode: 'serial' })
test.describe('document lifecycle', () => {
  let handle: AppHandle
  let scratch: string
  test.beforeAll(async () => {
    handle = await launchApp()
    // One real file on disk. A draft is the only document the app can create in one click, and
    // only ONE unsaved draft may exist at a time (the New Draft control is disabled while one is
    // open) — so the two documents a switch needs are a file plus that draft.
    scratch = mkTempDir('markflow-e2e-lifecycle-')
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })
  test.beforeEach(async () => {
    await resetAppState(handle)
  })

  // Create a document through the REAL sidebar "+" button (handleCreate), which
  // calls useCreateDocument -> invalidates the React Query cache and activates
  // the new draft, exactly like a real user click. The editor opens in edit mode.
  async function createViaButton(page: Page) {
    await page.getByTestId('new-document-btn').click()
    await expect(page.locator('.cm-content')).toBeVisible()
  }

  // Open a workspace holding ONE real file, through the same IPC pipeline the "Open Folder" menu
  // uses: setWorkspaceRoot -> importMany -> setActiveFolder, and activate the imported file.
  //
  // The file is (re)written on every call: `resetAppState` deletes the documents of the previous
  // case, and deleting a FILE document moves the file to the OS trash — a file seeded once in
  // beforeAll would be gone by the time the next case opened the workspace.
  async function openWorkspaceWithFile(page: Page): Promise<void> {
    writeFileSync(join(scratch, 'other.md'), '# Other document\n', 'utf-8')
    await page.evaluate(async (root) => {
      const w = window as any
      const { markdownFiles } = await w.api.files.resolvePaths([root])
      // Root FIRST: opening REPLACES the workspace (ADR-0023), so it must be set before the import.
      await w.api.documents.setWorkspaceRoot(root)
      const imported = await w.api.documents.importMany(markdownFiles)
      const ui = w.__uiStore.getState()
      ui.setActiveFolder(root)
      if (imported.length > 0) ui.setActiveDocumentId(imported[0].id)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, scratch)
  }

  // Read a native menu item's live enabled flag from the MAIN process. The renderer only mirrors
  // the state over IPC, so this is the only place the real item can be observed.
  function nativeMenuItemEnabled(h: AppHandle, id: string): Promise<boolean | undefined> {
    return h.electronApp.evaluate(
      ({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled,
      id,
    )
  }

  // At most one unsaved draft is a cross-process rule. The toolbar button disables itself, and the
  // native File > New Draft item must follow through the `menu:set-has-draft` sync — otherwise the
  // menu (and its ⌘N accelerator) is the one entry point that still invites a second draft.
  test('the native File > New Draft item follows the at-most-one-draft rule', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // No draft yet: the item is in its normal enabled state.
    await expect.poll(() => nativeMenuItemEnabled(handle, 'new-draft')).toBe(true)

    await createViaButton(page)
    await expect.poll(() => nativeMenuItemEnabled(handle, 'new-draft')).toBe(false)
    await expect(page.getByTestId('new-document-btn')).toBeDisabled()

    // Closing the unsaved draft deletes it from the main-process store, which must re-enable the
    // item — the rule is a state, not a one-way latch.
    await page.getByTestId('close-btn').click()
    await expect.poll(() => nativeMenuItemEnabled(handle, 'new-draft')).toBe(true)
  })

  test('creating a document shows it in the editor and supports view modes', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await createViaButton(page)
    await expect(page.locator('.cm-content')).toBeVisible()

    // Split is the default: both editor and preview are present.
    await expect(page.locator('.cm-editor')).toHaveCount(1)

    // Switch to preview-only: the CodeMirror editor must unmount.
    await page.getByTestId('view-preview').click()
    await expect(page.locator('.cm-editor')).toHaveCount(0)
    await expect(page.locator('h1')).toContainText('Untitled')

    // Switch back to edit-only: the editor returns.
    await page.getByTestId('view-edit').click()
    await expect(page.locator('.cm-editor')).toHaveCount(1)
  })

  test('read-only / edit toggle drives the editor contenteditable state', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // The toggle is inline only in the expanded pane bar; in the default environment the column is
    // folded and the toggle lives in the single "…" overflow (Q3). The `wide` environment expands
    // the bar, so this drives the real button.
    await page.setViewportSize(VIEWPORTS.wide)

    await createViaButton(page)

    // The editor mounts with the newly-created document active. The toggle
    // button (data-testid) is always present; we drive it through real clicks
    // and verify the contenteditable attribute on the editor content reflects
    // the resulting mode.
    const toggle = page.getByTestId('editor-readonly-btn')

    // Initial state after creating a draft: editable. The button is reachable.
    await expect(toggle).toBeVisible()

    // Click once -> editable flips.
    await toggle.click()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

    // Click again -> back to editable.
    await toggle.click()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
  })

  test('switching documents resets edit mode back to read-only', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Two documents: a real file on disk plus one draft (the draft becomes active + editable).
    // Only ONE unsaved draft may exist at a time, so the pair cannot be two drafts.
    await openWorkspaceWithFile(page)
    await createViaButton(page)

    // handleCreate opens the new draft in edit mode.
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')

    // Click the OTHER document. It is addressed by its document id, NOT by its position in the
    // list: the sidebar sorts newest-first, so the first row IS the active document — clicking
    // it would re-select the active doc, the switch would never happen, and the assertion
    // below would be vacuous. Two documents created in the same millisecond even tie, and the
    // sort is stable, so "first row" is not a stable reference to any document at all.
    const activeId = await page.evaluate(
      () => (window as any).__uiStore.getState().activeDocumentId as string,
    )
    const rowIds = await page
      .getByTestId('doc-item')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-doc-id')))
    const otherIndex = rowIds.findIndex((id) => id !== activeId)
    expect(otherIndex).toBeGreaterThanOrEqual(0)
    await page.getByTestId('doc-item').nth(otherIndex).click()

    // The switch must actually have happened, otherwise the read-only assertion below could
    // pass for the wrong reason (an editor that was never left in edit mode).
    await expect
      .poll(() => page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId))
      .not.toBe(activeId)

    // Switching documents must drop back to read-only (the classic bug guard).
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  })

  test('typing into the editor updates the document content', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await createViaButton(page)

    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('Hello from e2e')
    await expect(editor).toContainText('Hello from e2e')
  })

  // App-level REGRESSION test for todo ①. Measured 2026-11-05 with the diagnosing-bugs loop
  // (`--repeat-each=10 --workers=6`): 8/10 RED before the fix, 10/10 GREEN after. The cause was
  // a 400ms debounced onChange that carried correctness state and outlived its document: a
  // keystroke in A fired after the switch and wrote A's text into B's draft, which isDocSwitch
  // then force-applied to B's EditorView — so Ctrl+Z replayed it. Fixed by giving each document
  // its own editing session (aborted on switch) and committing dirty/registry/draft on the
  // keystroke frame; the debounce now only refreshes the preview. See ADR-0033 and testing.md.
  test('Ctrl+Z never crosses a document switch into the previous file (todo 1)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const activeId = () =>
      page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId as string)
    const clearDirty = () =>
      page.evaluate(() => (window as any).__uiStore.getState().setDirty(false))
    const makeEditable = async () => {
      await page.evaluate(() => (window as any).__uiStore.getState().setEditable(true))
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
    }
    const editor = page.locator('.cm-content')

    // These are UNSAVED documents, so a switch reloads the stored content. That is fine: the case
    // asserts that no PREVIOUS document text ever leaks in, not that unsaved typing survives a
    // switch. Only ONE unsaved draft may exist at a time (the New Draft control is disabled while
    // one is open), so the pair is a real file on disk (A) plus that draft (B).
    await openWorkspaceWithFile(page) // A: a real file on disk
    const alphaId = await activeId()
    // The editor mounts once the activated document's detail query resolves.
    await expect(page.locator('.cm-content')).toBeVisible()
    await makeEditable()
    await editor.click()
    await page.keyboard.type('ALPHA-DOC')

    await clearDirty()
    await createViaButton(page) // B
    const betaId = await activeId()
    await editor.click()
    await page.keyboard.type('BETA-DOC')

    // A SIDEBAR switch — not a new draft — is the path the reported bug walked: the persistent
    // EditorView keeps A's undo history while its content is replaced wholesale by B's.
    await clearDirty()
    await page.locator(`[data-testid="doc-item"][data-doc-id="${alphaId}"]`).click()
    await expect.poll(activeId).toBe(alphaId)
    await makeEditable()
    await editor.click()
    await page.keyboard.type('ALPHA-AGAIN')
    // Positive proof that A's text really landed: without it, the leak assertion below would
    // pass vacuously (an editor that never received the text cannot leak it).
    await expect(editor).toContainText('ALPHA-AGAIN')
    await clearDirty()
    await page.locator(`[data-testid="doc-item"][data-doc-id="${betaId}"]`).click()
    await expect.poll(activeId).toBe(betaId)
    // The PREVIOUS document's editing session is aborted on switch, so its pending preview
    // debounce can no longer write A's text into B's draft (which isDocSwitch would otherwise
    // force-apply here and Ctrl+Z would replay).
    await expect(
      editor,
      'the new document must not open with the previous one’s text',
    ).not.toContainText('ALPHA-')
    await makeEditable()
    await editor.click()
    await page.keyboard.type('BETA-AGAIN')

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

    // Positive proof that the shortcut ACTUALLY reaches CodeMirror: without this, a no-op
    // keypress would leave the buffer untouched and every negative assertion would be vacuous.
    const beforeUndo = (await editor.textContent()) ?? ''
    await page.keyboard.press(`${mod}+z`)
    await expect.poll(() => editor.textContent()).not.toBe(beforeUndo)

    // Every further undo step must stay inside B. A replayed document load would surface A's text
    // at an INTERMEDIATE step and then lose it again as A's own typing was undone — so checking
    // only the final state is not enough.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press(`${mod}+z`)
      expect(await editor.textContent(), `undo step ${i + 2}`).not.toContain('ALPHA-')
    }

    // A programmatic document load is NOT an undoable event: once the history is exhausted,
    // further Ctrl+Z must be a no-op.
    const stable = (await editor.textContent()) ?? ''
    for (let i = 0; i < 4; i += 1) await page.keyboard.press(`${mod}+z`)
    expect(await editor.textContent()).toBe(stable)
    await expect(editor).toBeVisible()
  })

  // Q14: correctness state must be committed on the keystroke frame, not by the 400ms debounce.
  // Before the fix, switching or saving inside that window saw dirty === false and silently lost
  // the user's edit (the unsaved-switch guard never even fired).
  test('a keystroke commits dirty + the unsaved buffer before the debounce window', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createViaButton(page)
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('TYPED-JUST-NOW')

    // Read IMMEDIATELY — no waitForTimeout, no 400ms debounce. A single poll would hide the bug.
    const state = await page.evaluate(() => {
      const w = window as any
      const s = w.__uiStore.getState()
      return {
        dirty: s.dirty,
        reported: s.unsavedBuffers[s.activeDocumentId]?.content ?? null,
      }
    })
    expect(state.dirty, 'the unsaved-switch guard must see this edit at once').toBe(true)
    expect(state.reported, 'content search must see the unsaved text at once').toContain(
      'TYPED-JUST-NOW',
    )
  })

  // Companion to the single-keystroke Q14 lock: selector-scoped store subscriptions are a
  // performance fix, so they must NOT change the per-keystroke registry contract. Content search
  // and cross-file replace read this registry at call time; coalescing the writes into the 400ms
  // preview debounce would make them read stale text (see ADR-0033 Consequences).
  test('consecutive keystrokes keep the unsaved buffer registry in lockstep', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await createViaButton(page)
    await page.locator('.cm-content').click()

    const before = await page.evaluate(
      () => (window as any).__uiStore.getState().documentStateRevision as number,
    )
    const typed = 'SELECTOR-LOCK-42'
    await page.keyboard.type(typed)

    // Read IMMEDIATELY — no debounce wait, exactly like the Q14 case above.
    const after = await page.evaluate(() => {
      const s = (window as any).__uiStore.getState()
      return {
        revision: s.documentStateRevision as number,
        dirty: s.dirty as boolean,
        reported: (s.unsavedBuffers[s.activeDocumentId]?.content ?? null) as string | null,
      }
    })

    expect(after.dirty).toBe(true)
    expect(after.reported, 'content search must see the full typed text at once').toContain(typed)
    expect(
      after.revision - before,
      'one registry write per keystroke, not one coalesced write',
    ).toBeGreaterThanOrEqual(typed.length)

    // Actions are read through getState() rather than subscribed (Vercel rerender-defer-reads),
    // while the view-mode UI still depends on a field-scoped selector. Driving both through the
    // real UI proves the action reference survived the registry writes AND the selector still
    // re-renders the control.
    await page.getByTestId('view-preview').click()
    await expect(page.getByTestId('view-preview')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('view-split').click()
    await expect(page.getByTestId('view-split')).toHaveAttribute('aria-checked', 'true')
  })

  test('switching inside the debounce window still prompts instead of discarding silently', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Two documents so the sidebar has a switch target: a real file on disk plus one draft. Only
    // ONE unsaved draft may exist at a time (the New Draft control is disabled while one is
    // open), so the pair cannot be two drafts.
    await openWorkspaceWithFile(page) // A (the file on disk)
    await createViaButton(page) // B (the draft — active, and the one that gets the unsaved edit)
    const activeId = await page.evaluate(
      () => (window as any).__uiStore.getState().activeDocumentId as string,
    )
    const otherId = await page
      .getByTestId('doc-item')
      .evaluateAll(
        (rows, self) =>
          rows.map((r) => r.getAttribute('data-doc-id')).find((id) => id !== self) as string,
        activeId,
      )
    expect(otherId).toBeTruthy()

    // Keep-editing answer (0) so the switch is declined and we can assert the guard was offered.
    await installConfirmSpy(handle, { defaultResponse: 0 })
    await page.locator('.cm-content').click()
    await page.keyboard.type('UNSAVED-IN-WINDOW')
    // Click the other row at once — well inside the old 400ms window.
    await page.locator(`[data-testid="doc-item"][data-doc-id="${otherId}"]`).click()
    await expect
      .poll(async () => (await getConfirmCalls(handle)).length, {
        message: 'the unsaved-switch guard must be offered',
      })
      .toBeGreaterThan(0)
    expect(
      await page.evaluate(() => (window as any).__uiStore.getState().activeDocumentId as string),
    ).toBe(activeId)
    await expect(page.locator('.cm-content')).toContainText('UNSAVED-IN-WINDOW')
  })
})
