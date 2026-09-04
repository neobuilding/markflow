// TODO-4 regression (docs.local/todo_title-edit.md): renaming a file — via the title
// bar or externally — and renaming it back must NEVER close the open document or the
// workspace. Guards the main-process watcher fixes: the existsSync check in
// onFileRemoved (stale rename unlink), the missing-flag instead of record deletion,
// and findRenamedDocument folding an external rename back into the SAME record.
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { mkdtempSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test.describe('rename round-trip keeps the document and workspace open', () => {
  let handle: AppHandle

  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  /**
   * Open `file` through the same steps useOpenPaths performs (resolvePaths ->
   * importMany -> set-open-folder -> setActiveFolder/setActiveDocumentId), switch it
   * into edit mode, and instrument the renderer: every main-process push event and
   * every activeDocumentId/activeFolder transition is recorded into window.__trace.
   */
  async function openFile(file: string): Promise<string> {
    const { page } = handle
    const id = await page.evaluate(
      async (args) => {
        const w = window as any
        const dir = (() => {
          const i = Math.max(args.file.lastIndexOf('\\'), args.file.lastIndexOf('/'))
          return i > 0 ? args.file.slice(0, i) : ''
        })()
        const { directories, markdownFiles } = await window.api.files.resolvePaths([args.file])
        const imported = await window.api.documents.importMany(markdownFiles)
        await window.api.documents.setOpenFolder(directories[0] ?? dir)
        const ui = w.__uiStore.getState()
        ui.setActiveFolder(dir)
        ui.setActiveDocumentId(imported[0].id)
        ui.setDirty(false)
        ui.setEditable(true)

        const trace: string[] = []
        w.__trace = trace
        const t0 = Date.now()
        window.api.onFolderChanged((d: unknown) =>
          trace.push(`+${Date.now() - t0}ms folder-changed ${JSON.stringify(d)}`),
        )
        if (window.api.onDocumentRefresh)
          window.api.onDocumentRefresh((d: unknown) =>
            trace.push(`+${Date.now() - t0}ms document-refresh ${JSON.stringify(d)}`),
          )
        window.api.onFileChanged((d: unknown) =>
          trace.push(`+${Date.now() - t0}ms file-changed ${JSON.stringify(d)}`),
        )
        let prev = w.__uiStore.getState()
        w.__uiStore.subscribe((s: any) => {
          if (
            s.activeDocumentId !== prev.activeDocumentId ||
            s.activeFolder !== prev.activeFolder
          ) {
            trace.push(
              `+${Date.now() - t0}ms STATE doc=${s.activeDocumentId} folder=${s.activeFolder}`,
            )
          }
          prev = s
        })
        return imported[0].id
      },
      { file },
    )
    await page.waitForTimeout(100)
    return id
  }

  /** Rename through the real UI: the pencil button, the input, Enter, then Save. */
  async function renameViaUI(newName: string) {
    const { page } = handle
    await page.getByTestId('rename-title-btn').click()
    const input = page.locator('input').first()
    await input.fill(newName)
    await input.press('Enter')
    await page.getByTestId('save-btn').click()
  }

  async function dumpState(tag: string) {
    const state = await handle.page.evaluate(() => {
      const s = (window as any).__uiStore.getState()
      return { activeDocumentId: s.activeDocumentId, activeFolder: s.activeFolder, dirty: s.dirty }
    })
    console.log(`--- state ${tag} ---`, JSON.stringify(state))
    return state
  }

  test('in-app rename a.md -> b.md -> a.md (TODO-4 repro steps)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-rename1-'))
    const file = join(scratch, 'a.md')
    writeFileSync(file, '# Hello\n\nbody', 'utf-8')

    const id = await openFile(file)
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')

    await renameViaUI('b.md')
    await expect(page.getByTestId('title-btn')).toHaveText('b.md')
    // The rename must have actually been WRITTEN TO DISK by that Save click — the
    // title bar alone shows the draft (TODO 3), so prove the save landed: b.md
    // exists, a.md is gone, and the store record points at b.md.
    expect(existsSync(join(scratch, 'b.md'))).toBe(true)
    expect(existsSync(join(scratch, 'a.md'))).toBe(false)
    const savedPath1 = await page.evaluate(
      (i) => window.api.documents.get(i).then((d: any) => d.filePath),
      id,
    )
    expect(savedPath1.replace(/\\/g, '/')).toBe(join(scratch, 'b.md').replace(/\\/g, '/'))
    // Let the watcher's unpaired unlink(a.md)/add(b.md) land and be folded in.
    await page.waitForTimeout(1500)

    await renameViaUI('a.md')
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')
    // Second Save: the file is back on disk at the original name, the rename
    // target is gone, content survived, and the record points back at a.md.
    expect(existsSync(join(scratch, 'a.md'))).toBe(true)
    expect(existsSync(join(scratch, 'b.md'))).toBe(false)
    expect(readFileSync(join(scratch, 'a.md'), 'utf-8')).toContain('# Hello')
    const savedPath2 = await page.evaluate(
      (i) => window.api.documents.get(i).then((d: any) => d.filePath),
      id,
    )
    expect(savedPath2.replace(/\\/g, '/')).toBe(join(scratch, 'a.md').replace(/\\/g, '/'))
    // Give every watcher event (including late/stale ones) time to arrive.
    await page.waitForTimeout(3000)

    const state = await dumpState('round-trip final')
    const trace = (await page.evaluate(() => (window as any).__trace)) as string[]
    console.log('--- trace ---\n' + trace.join('\n'))

    // Document still open, still the same record, original name; folder still open.
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')
    expect(state.activeDocumentId).toBe(id)
    expect(state.activeFolder).not.toBeNull()

    // Harness sanity: the folder watcher must be LIVE — an external file creation
    // must reach the renderer as a folder-changed event. Without this check the
    // assertions above could pass vacuously with a dead watcher.
    writeFileSync(join(scratch, 'zz-probe.md'), '# zz', 'utf-8')
    await page.waitForTimeout(3000)
    const trace2 = (await page.evaluate(() => (window as any).__trace)) as string[]
    expect(trace2.join('\n')).toContain('folder-changed')
  })

  test('fast back-to-back rename round-trip with no settle pause', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-rename2-'))
    const file = join(scratch, 'a.md')
    writeFileSync(file, '# Hello\n\nbody', 'utf-8')

    const id = await openFile(file)
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')

    await renameViaUI('b.md')
    await expect(page.getByTestId('title-btn')).toHaveText('b.md')
    // NO pause: chokidar events from step 1 are still in flight while step 2 runs.
    await renameViaUI('a.md')
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')
    await page.waitForTimeout(4000)

    const state = await dumpState('fast round-trip final')
    expect(state.activeDocumentId).toBe(id)
    expect(state.activeFolder).not.toBeNull()
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')
  })

  test('external rename (Explorer-style) to a new name and back keeps the same record', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const scratch = mkdtempSync(join(tmpdir(), 'markflow-e2e-rename3-'))
    const fileA = join(scratch, 'a.md')
    writeFileSync(fileA, '# Hello\n\nbody', 'utf-8')

    const id = await openFile(fileA)
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')

    // External rename a.md -> c.md (the app sees unlink + add, unpaired).
    const fileC = join(scratch, 'c.md')
    renameSync(fileA, fileC)
    await expect(page.getByTestId('title-btn')).toHaveText('c.md')
    await page.waitForTimeout(2500)

    // And back: c.md -> a.md — the exact shape of a stale unlink for a.md.
    renameSync(fileC, fileA)
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')
    await page.waitForTimeout(3000)

    const state = await dumpState('external round-trip final')
    const trace = (await page.evaluate(() => (window as any).__trace)) as string[]
    console.log('--- external trace ---\n' + trace.join('\n'))

    // The SAME record (id) must have followed both renames — never dropped, never
    // replaced by a new record that would leave the editor in the notFound state.
    expect(state.activeDocumentId).toBe(id)
    expect(state.activeFolder).not.toBeNull()
    await expect(page.getByTestId('title-btn')).toHaveText('a.md')
  })
})
