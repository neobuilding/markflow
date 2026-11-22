import type {} from '../../src/renderer/src/vite-env.d.ts'
import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  waitForAppReady,
  closeApp,
  installConfirmSpy,
  getConfirmCalls,
  AppHandle,
} from '../helpers/launch'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// ADR-0029 §5 guard chain, end to end. The store unit tests can only prove that a reload was
// REQUESTED; this spec proves the user-visible guarantee: on "discard" the editor really shows the
// bytes currently on disk, not the discarded draft. The disk file is changed BEFORE the document
// becomes active, and no workspace is opened, so the folder watcher cannot mask the reload by
// refreshing the renderer's document from the main store first.
test.describe('edit -> read-only discard guard (ADR-0029 §5)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-readonly-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openDirtyDocument(page: Page): Promise<void> {
    await waitForAppReady(page)
    const diskPath = join(scratch, 'alpha.md')
    mkdirSync(dirname(diskPath), { recursive: true })
    writeFileSync(diskPath, '# Alpha\n\noriginal body\n', 'utf-8')

    const id = await page.evaluate((file) => {
      return window.api.documents.import(file).then((doc) => {
        if (!doc) throw new Error('documents.import returned null')
        return doc.id
      })
    }, diskPath)

    // The main store still holds "original body"; only disk has the fresh bytes. The editor must
    // therefore gain "FRESH FROM DISK" through the discard-triggered reload, not through a query
    // refresh of an already-updated store record.
    writeFileSync(diskPath, '# Alpha\n\nFRESH FROM DISK\n', 'utf-8')

    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__uiStore.getState().setEditable(true)
      w.__uiStore.getState().setViewMode('edit')
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)

    await page.locator('.cm-content').click()
    await page.keyboard.type(' UNSAVED TAIL')
    await page.waitForFunction(() => (window as any).__uiStore.getState().dirty === true)
  }

  test('declining the prompt keeps edit mode, the draft and the editor untouched', async () => {
    const { page } = handle
    await openDirtyDocument(page)
    await installConfirmSpy(handle, { defaultResponse: 0 }) // "Keep editing"

    await page.getByTestId('editor-readonly-btn').click()

    await page.waitForTimeout(300)
    const calls = await getConfirmCalls(handle)
    expect(calls.length).toBe(1)
    expect(calls[0].message?.toLowerCase()).toContain('read-only')
    expect(calls[0].buttons).toEqual(['Keep editing', 'Discard'])
    const state = await page.evaluate(() => {
      const w = window as any
      return {
        editable: w.__uiStore.getState().editable,
        dirty: w.__uiStore.getState().dirty,
        focus: document.activeElement?.className ?? '',
      }
    })
    expect(state.editable).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.focus).toContain('cm-content')
    await expect(page.locator('.cm-content')).toContainText('UNSAVED TAIL')
    await expect(page.locator('.cm-content')).not.toContainText('FRESH FROM DISK')
  })

  test('discarding switches to read-only and loads the latest bytes from disk', async () => {
    const { page } = handle
    await openDirtyDocument(page)
    await installConfirmSpy(handle, { defaultResponse: 1 }) // "Discard"

    await page.getByTestId('editor-readonly-btn').click()

    await page.waitForFunction(() => {
      const w = window as any
      return w.__uiStore.getState().editable === false && w.__uiStore.getState().dirty === false
    })
    await expect(page.locator('.cm-content')).toContainText('FRESH FROM DISK')
    await expect(page.locator('.cm-content')).not.toContainText('UNSAVED TAIL')
  })
})
