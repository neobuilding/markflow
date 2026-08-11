import type {} from '../../src/renderer/src/vite-env.d.ts'
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'

// Covers the Plan's §2 (preload split into api/* submodules) and the main-process
// handler groups from §1.2.2. The refactor is a pure relocation, so the contract
// we must guarantee is: every `window.api.*` group + method the renderer depends on
// still exists and is callable after the preload/index.ts reassembly, and the
// per-domain IPC handlers registered by the split main modules still respond.
//
// If any of the api/* files drop a method (e.g. accidentally omitting
// app.getInitialPaths / dialog.openFolderPath / window.isMaximized), or a main
// handler group fails to register, these assertions fail loudly instead of only
// surfacing as a runtime crash in the renderer.
test.describe('preload bridge contract (api/* split)', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Walk the full Api surface that the plan's §2.2 says must stay byte-identical
  // to vite-env.d.ts. We assert every method is a function (exists), which is the
  // contract the refactor must preserve.
  test('every api group + method from the Api interface is exposed', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const surface = await page.evaluate(() => {
      const a = window.api as any
      const collect = (obj: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v]))
      return {
        documents: collect(a.documents),
        export: collect(a.export),
        search: collect(a.search),
        app: collect(a.app),
        files: collect(a.files),
        dialog: collect(a.dialog),
        window: collect(a.window),
        menu: collect(a.menu),
        events: {
          onMenuEvent: typeof a.onMenuEvent,
          onFileChanged: typeof a.onFileChanged,
          onOpenPaths: typeof a.onOpenPaths,
          onAppRequestQuit: typeof a.onAppRequestQuit,
        },
      }
    })

    // documents — §2.2
    expect(surface.documents).toEqual(
      expect.objectContaining({
        list: 'function',
        get: 'function',
        create: 'function',
        update: 'function',
        delete: 'function',
        import: 'function',
        importMany: 'function',
        saveAs: 'function',
        reload: 'function',
        setEncoding: 'function',
        stat: 'function',
        eol: 'function',
        watch: 'function',
        unwatch: 'function',
      }),
    )
    // export — §2.2
    expect(surface.export).toEqual(
      expect.objectContaining({
        embedImages: 'function',
        write: 'function',
        print: 'function',
      }),
    )
    // search — §2.2
    expect(surface.search).toEqual(expect.objectContaining({ query: 'function' }))
    // app — §2.2 (getInitialPaths / showInFolder / setLanguage / allowQuit are the
    // easily-omitted four called out in the plan)
    expect(surface.app).toEqual(
      expect.objectContaining({
        getTheme: 'function',
        setTheme: 'function',
        getVersion: 'function',
        getInitialPaths: 'function',
        showInFolder: 'function',
        setLanguage: 'function',
        allowQuit: 'function',
      }),
    )
    // files — §2.2 (getPathForFile + resolvePaths)
    expect(surface.files).toEqual(
      expect.objectContaining({
        resolvePaths: 'function',
        getPathForFile: 'function',
      }),
    )
    // dialog — §2.2 (openFolderPath + saveHtmlFile are the easily-omitted two)
    expect(surface.dialog).toEqual(
      expect.objectContaining({
        openFiles: 'function',
        openFolder: 'function',
        openFolderPath: 'function',
        saveFile: 'function',
        saveHtmlFile: 'function',
        confirm: 'function',
      }),
    )
    // window — §2.2 (maximize/unmaximize/isMaximized ONLY; focus must NOT exist,
    // per the voided §1.5 / R1)
    expect(surface.window).toEqual(
      expect.objectContaining({
        maximize: 'function',
        unmaximize: 'function',
        isMaximized: 'function',
      }),
    )
    expect(surface.window).not.toHaveProperty('focus')
    // menu — §2.2
    expect(surface.menu).toEqual(
      expect.objectContaining({
        setEditable: 'function',
        setHasDocument: 'function',
        setPrinting: 'function',
      }),
    )
    // 4 event subscriptions — §2.2 events.ts
    expect(surface.events).toEqual({
      onMenuEvent: 'function',
      onFileChanged: 'function',
      onOpenPaths: 'function',
      onAppRequestQuit: 'function',
    })
  })

  test('dialog:confirm (app-modal focus fix) is a callable bridge function', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // The plan §0 R1 calls out `dialog:confirm` (dialog.showMessageBox, app-modal)
    // as the real fix for the editor-focus bug. It must stay wired after the
    // preload dialog group is moved to api/dialog.ts and the handler to
    // handlers/dialog.ts.
    // We do NOT invoke the real dialog here: the preload bridge exposes a frozen
    // object (so dialog.confirm cannot be stubbed) and a real invocation would
    // block the test on a native modal. This test only asserts the bridge exposes
    // it as a function (its existence + the full method set is already locked down
    // by the "every api group + method" test above).
    const type = await page.evaluate(() => typeof window.api.dialog.confirm)
    expect(type).toBe('function')
  })

  test('window:maximize / is-maximized toggle and report state', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // handlers/window.ts (§1.2.2 E) — these handlers reference getMainWindow()?.
    // Verify the preload window group (api/window.ts) still drives them.
    //
    // The *native* maximize state is environment-dependent: under a real window
    // manager (a local desktop) `maximize()` flips `isMaximized()` to true and
    // `unmaximize()` back to false. But headless CI runs on a virtual display
    // (Xvfb) with no reliable window manager — openbox does not consistently
    // register as the WM there, so `_NET_WM_STATE_MAXIMIZED_*` is never set and
    // `isMaximized()` stays false even after a successful `maximize()` call.
    // That WM behavior is NOT part of the preload bridge contract, so we never
    // assert on it in CI; we only assert the bridge is callable and returns the
    // correct shape (boolean) in every environment.
    const before = await page.evaluate(() => window.api.window.isMaximized())
    await page.evaluate(() => window.api.window.maximize())
    // Let the IPC call land; harmless on CI where the native state won't change.
    await page.waitForTimeout(500)
    const afterMax = await page.evaluate(() => window.api.window.isMaximized())
    await page.evaluate(() => window.api.window.unmaximize())
    await page.waitForTimeout(500)
    const afterUnmax = await page.evaluate(() => window.api.window.isMaximized())

    // Bridge contract: every call returns a boolean (never throws / undefined).
    expect(typeof before).toBe('boolean')
    expect(typeof afterMax).toBe('boolean')
    expect(typeof afterUnmax).toBe('boolean')

    // The real maximize toggle is only asserted where a window manager exists.
    // On CI (process.env.CI is set by GitHub Actions) the virtual display has no
    // reliable WM, so we skip the state assertions to avoid a known false negative.
    if (!process.env.CI) {
      expect(afterMax).toBe(true)
      expect(afterUnmax).toBe(false)
    }
  })

  test('app:getInitialPaths and app:getVersion respond', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // handlers/app.ts (§1.2, previously lumped into other groups) — getInitialPaths
    // reads pendingInitialPaths from state.ts, getVersion from app.getVersion().
    const paths = await page.evaluate(() => window.api.app.getInitialPaths())
    expect(Array.isArray(paths)).toBe(true)

    const version = await page.evaluate(() => window.api.app.getVersion())
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  })

  test('files:resolvePaths returns classified directories + markdown files', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // handlers/files.ts (§1.2) — depends on MD_EXTS + collectMarkdownFiles.
    const res = await page.evaluate(() => window.api.files.resolvePaths([]))
    expect(res).toEqual(
      expect.objectContaining({
        directories: expect.any(Array),
        markdownFiles: expect.any(Array),
      }),
    )
  })

  test('search:query returns an array (handler still registered)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // ipc/search.ts is untouched by the plan, but the preload search group moved to
    // api/search.ts, so confirm the bridge still routes to the handler.
    const results = await page.evaluate(() => window.api.search.query('anything'))
    expect(Array.isArray(results)).toBe(true)
  })

  test('onMenuEvent subscription returns a callable unsubscribe function', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // api/events.ts (§2.2) — the onIpc helper must still return an unsubscribe that
    // removes the listener. NOTE: page.evaluate cannot serialize a function return
    // value, so we assert the unsubscribe is a function AND callable entirely inside
    // the page, returning a plain boolean result.
    const ok = await page.evaluate(() => {
      const unsub = window.api.onMenuEvent('new-document', () => {})
      if (typeof unsub !== 'function') return false
      try {
        unsub() // must not throw
        return true
      } catch {
        return false
      }
    })
    expect(ok).toBe(true)
  })

  test('files:getPathForFile returns a string and does not throw (webUtils import)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // api/files.ts (§2.2) — getPathForFile uses electron.webUtils.getPathForFile. The
    // refactor must keep that binding working after the preload split. A File built in
    // memory (new File(...)) has no underlying disk path, so webUtils returns '' — the
    // contract we assert here is simply: it returns a string and never throws. (Real
    // paths only exist for files chosen via <input type=file> / drag-drop, which e2e
    // cannot synthesize; the actual path resolution is covered by file-roundtrip.spec.)
    const result = await page.evaluate(() => {
      try {
        const file = new File(['hello'], 'note.md', { type: 'text/markdown' })
        const path = window.api.files.getPathForFile(file as any)
        return { ok: true, type: typeof path }
      } catch {
        return { ok: false, type: 'n/a' }
      }
    })
    expect(result.ok).toBe(true)
    expect(result.type).toBe('string')
  })

  test('app:setTheme / getTheme round-trip (theme handlers split)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // handlers/theme.ts (§1.2.2) — app:get-theme / app:set-theme moved here. Verify
    // the round-trip: set a concrete theme and read it back.
    const before = await page.evaluate(() => window.api.app.getTheme())
    expect(['light', 'dark']).toContain(before)

    await page.evaluate(() => window.api.app.setTheme('dark'))
    const afterDark = await page.evaluate(() => window.api.app.getTheme())
    expect(afterDark).toBe('dark')

    await page.evaluate(() => window.api.app.setTheme('light'))
    const afterLight = await page.evaluate(() => window.api.app.getTheme())
    expect(afterLight).toBe('light')
  })
})
