// Export dialog e2e — E11 (one export entry point), E12 (disabled while rendering), E13 (shadow
// root parity).
//
// One app launch for the whole file; each scenario keeps its own labelled step. Every step closes
// its modal before the next, and the dark-theme step runs LAST so it cannot tint the light one.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { VIEWPORTS } from '../helpers/viewports'

interface ShadowProbe {
  hasMarkdownBody: boolean
  theme: string | null
  containerPadding: string | null
  preBg: string | null
  preRadius: string | null
  keywordColor: string | null
  pageBackgroundColor: string | null
  hasExportCss: boolean
  hasFontFace: boolean
}

/** Read the export preview's shadow tree — the thing the feature exists to prove. */
async function probeShadow(host: Locator): Promise<ShadowProbe | null> {
  return host.evaluate((el) => {
    const root = (el as HTMLElement).shadowRoot
    if (!root) return null
    const md = root.querySelector('.markdown-body') as HTMLElement | null
    const container = root.querySelector('.export-preview-container') as HTMLElement | null
    const pre = root.querySelector('pre') as HTMLElement | null
    const keyword = root.querySelector('.hljs-keyword') as HTMLElement | null
    const styles = Array.from(root.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n')
    return {
      hasMarkdownBody: !!md,
      theme: md?.getAttribute('data-theme') ?? null,
      containerPadding: container ? getComputedStyle(container).paddingTop : null,
      preBg: pre ? getComputedStyle(pre).backgroundColor : null,
      preRadius: pre ? getComputedStyle(pre).borderRadius : null,
      keywordColor: keyword ? getComputedStyle(keyword).color : null,
      pageBackgroundColor: md ? getComputedStyle(md).backgroundColor : null,
      hasExportCss: styles.includes('.markdown-body pre.hljs'),
      hasFontFace: styles.includes('@font-face'),
    }
  })
}

/** Read the app's own preview, for the parity comparison. */
async function probeAppPreview(pane: Locator): Promise<{
  preBg: string
  preRadius: string
  keywordColor: string | null
}> {
  return pane.evaluate((el) => {
    const pre = el.querySelector('pre') as HTMLElement
    const keyword = el.querySelector('.hljs-keyword') as HTMLElement | null
    return {
      preBg: getComputedStyle(pre).backgroundColor,
      preRadius: getComputedStyle(pre).borderRadius,
      keywordColor: keyword ? getComputedStyle(keyword).color : null,
    }
  })
}

/** A document with a highlighted code block, split view, export dialog open, preview painted. */
async function openExportPreview(
  page: Page,
): Promise<{ dialog: Locator; host: Locator; appPreview: Locator }> {
  // Only ONE unsaved draft may exist at a time (the New Draft control is disabled once one is
  // open), so reuse the document that is already open instead of asking for a second one — and
  // type the sample content only once, so the second call does not double it.
  const editor = page.locator('.cm-content')
  if ((await editor.count()) === 0) {
    await page.getByTestId('new-document-btn').click()
    await expect(editor).toBeVisible()
  }
  await editor.click()
  if (!(await editor.textContent())?.includes('const x = 1')) {
    await page.keyboard.type('# Heading\n\n```js\nconst x = 1\n```\n')
  }

  // Split view ⇒ the app preview (the pane) and the export preview (the dialog) can be
  // compared side by side.
  await page.getByTestId('view-split').click()
  const appPreview = page.locator('.markdown-preview')
  await expect(appPreview).toBeVisible()
  await expect(appPreview.locator('pre')).toBeVisible()

  await page.getByTestId('export-btn').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const host = dialog.getByTestId('export-preview')
  await expect(host).toBeVisible()
  await expect.poll(async () => (await probeShadow(host))?.hasMarkdownBody ?? false).toBe(true)
  return { dialog, host, appPreview }
}

async function closeDialog(page: Page, dialog: Locator) {
  await dialog.getByText('Cancel').click()
  await expect(dialog).toBeHidden()
  // The next scenario starts from the app's default light theme / ready state.
  await page.evaluate(() => (window as any).__uiStore.getState().setExportReady(true))
}

test.describe('export dialog', () => {
  let handle: AppHandle

  test.beforeAll(async () => {
    handle = await launchApp()
  })
  test.afterAll(async () => {
    await closeApp(handle)
  })

  test('one export entry point, rendering guard, and shadow-root parity', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await test.step('the preview bar opens the same dialog and only one export button is on screen', async () => {
      await page.getByTestId('new-document-btn').click()
      await expect(page.locator('.cm-content')).toBeVisible()

      // Split view ⇒ the preview is visible ⇒ the export entry point lives on the PREVIEW bar.
      await page.getByTestId('view-split').click()
      await expect(page.locator('.markdown-preview')).toBeVisible()

      // Exactly ONE export button on screen (the global bar's is hidden while the preview shows).
      await expect(page.getByTestId('export-btn')).toHaveCount(1)

      await page.getByTestId('export-btn').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      // The same dialog as the global bar's entry point: same title, same target-path field.
      await expect(dialog.getByText('Export as HTML')).toBeVisible()
      await expect(dialog.locator('input[readonly]')).toBeVisible()
      await closeDialog(page, dialog)
    })

    await test.step('the export button is disabled while the document is still rendering (E12)', async () => {
      // Simulate the "rendering in flight" window deterministically: the store flag is what the
      // preview flips while a document switch or a pending parse is in progress.
      //
      // WAIT for the just-typed document's own parse to fully settle FIRST. MarkdownPreview flips
      // exportReady → true inside the async parseMarkdown().then(...) callback; if we forced false
      // while that parse was still in flight, its later callback would clobber our false back to
      // true, and the button would read "Export" instead of "Preparing…" (race → element not found).
      await page.waitForFunction(() => (window as any).__uiStore.getState().exportReady === true)
      await page.evaluate(() => {
        ;(window as any).__uiStore.getState().setExportReady(false)
      })

      await page.getByTestId('export-btn').first().click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()

      const exportBtn = dialog.getByRole('button', { name: 'Preparing…' })
      await expect(exportBtn).toBeDisabled()

      // Once the document has rendered, the same button becomes actionable.
      await page.evaluate(() => {
        ;(window as any).__uiStore.getState().setExportReady(true)
      })
      await expect(dialog.getByRole('button', { name: 'Export' })).toBeEnabled()
      await closeDialog(page, dialog)
    })

    await test.step('the export preview renders the EXPORT document in a shadow root (E13)', async () => {
      const { dialog, host, appPreview } = await openExportPreview(page)

      const shadow = await probeShadow(host)

      expect(shadow, 'the preview must live in a shadow root').not.toBeNull()
      expect(shadow!.hasMarkdownBody).toBe(true)
      expect(shadow!.theme).toBe('light')
      // The export's own stylesheet is inlined (the shared .markdown-body overrides).
      expect(shadow!.hasExportCss).toBe(true)
      // S2: `body` does not match inside a shadow root, so the export's body-level padding has to
      // be applied to the preview container instead.
      expect(shadow!.containerPadding).toBe('24px')
      // C20 ⑨ fidelity: the preview host paints the EXPORTED page's own background, so the page
      // fills the preview edge-to-edge with no app-coloured (grey) margin ring. The host background
      // must equal the markdown-body page colour, and must NOT be the app chrome colour (#f5f7fb).
      const hostPageBg = await host.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(hostPageBg, 'host bg must equal the page bg').toBe(shadow!.pageBackgroundColor)
      expect(hostPageBg, 'host bg must not be the app chrome grey').toBe('rgb(255, 255, 255)')

      // S1: a shadow root does not register fonts, so the @font-face rules live in the HOST
      // document instead of the shadow root.
      expect(shadow!.hasFontFace).toBe(false)
      const hostFonts = await page.evaluate(() => ({
        declared: (
          document.getElementById('markflow-export-preview-fonts')?.textContent ?? ''
        ).includes('@font-face'),
        // FontFaceSet lists every DECLARED face, whether or not it has been loaded yet — so this
        // proves the KaTeX faces are really registered with the host document, not just present
        // as dead CSS text.
        katexFaces: Array.from(document.fonts).filter((f) => /KaTeX/i.test(f.family)).length,
      }))
      expect(hostFonts.declared).toBe(true)
      expect(
        hostFonts.katexFaces,
        'the KaTeX faces must be registered in the host document',
      ).toBeGreaterThan(10)

      // C33 parity, now asserted through the preview: the export preview and the app preview
      // must agree on the code-block box and on the syntax colors.
      const app = await probeAppPreview(appPreview)
      expect(shadow!.preBg).toBe(app.preBg)
      expect(shadow!.preRadius).toBe(app.preRadius)
      expect(shadow!.keywordColor).toBe(app.keywordColor)
      await closeDialog(page, dialog)
    })

    // Runs LAST: it switches the theme to dark, which would otherwise tint the light-theme step.
    await test.step('the export preview follows the dark theme (E13)', async () => {
      // C20 ⑨ W1: the preview follows the theme the EXPORT will use, not the app's own styling.
      await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
      const { dialog, host, appPreview } = await openExportPreview(page)

      const shadow = await probeShadow(host)
      expect(shadow, 'the preview must live in a shadow root').not.toBeNull()
      expect(shadow!.theme).toBe('dark')

      // The dark code-block box and the dark syntax palette must match the app preview exactly
      // (C33's invariant, now proven through the export preview).
      const app = await probeAppPreview(appPreview)
      expect(shadow!.preBg).toBe(app.preBg)
      expect(shadow!.preRadius).toBe(app.preRadius)
      expect(shadow!.keywordColor).toBe(app.keywordColor)
      // Anti-vacuity: the light palette puts keywords at a near-black colour and the dark palette
      // at #ff7b72 (markdownExport.css, dark hljs block), so this value also proves the DARK sheet
      // was applied rather than merely "some" colour.
      expect(shadow!.keywordColor).toBe('rgb(255, 123, 114)')

      // C20 ⑨ fidelity (dark): the host must equal the exported page colour (#0d1117 = rgb(13, 17, 23)),
      // not the app chrome dark (#0f1419 = rgb(15, 20, 25)).
      const hostPageBgDark = await host.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(hostPageBgDark, 'dark host bg must equal the page bg').toBe(
        shadow!.pageBackgroundColor,
      )
      expect(hostPageBgDark, 'dark host bg must not be the app chrome dark').toBe('rgb(13, 17, 23)')
      // Close it: this case runs last, and a modal left open would intercept the next case's clicks.
      await closeDialog(page, dialog)
    })
  })

  // R4: the dialog itself is a standard window — draggable by its title bar and resizable from its
  // edges/corners (the old in-preview grip is gone). The unit suite proves the clamp arithmetic;
  // here we drive the real pointers in a browser.
  test('the export dialog can be dragged by its title bar and resized from its edges (R4)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('light'))

    const { dialog } = await openExportPreview(page)
    const surface = dialog
    const header = dialog.getByTestId('export-dialog-header')

    // Count pointer events so a failed geometry assertion can say WHICH link broke: no
    // pointerdown, no pointermove, or no committed state. This file reuses ONE Electron page,
    // so the listeners are always removed in `finally`.
    await page.evaluate(() => {
      const w = window as any
      w.__r4Pointers = { down: 0, move: 0, up: 0 }
      w.__r4Handlers = {
        pointerdown: () => {
          w.__r4Pointers.down += 1
        },
        pointermove: () => {
          w.__r4Pointers.move += 1
        },
        pointerup: () => {
          w.__r4Pointers.up += 1
        },
      }
      for (const [name, handler] of Object.entries(w.__r4Handlers)) {
        window.addEventListener(name, handler as EventListener, true)
      }
    })

    try {
      const before = (await surface.boundingBox())!

      // Drag the title bar up-left. Pointer capture keeps the move events flowing even outside the
      // header, so the dialog should follow.
      const hb = (await header.boundingBox())!
      const sx = hb.x + hb.width / 2
      const sy = hb.y + 10
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(sx - 120, sy - 60, { steps: 6 })
      await page.mouse.up()

      // A bare boundingBox() can still report the pre-drag layout while React has not committed
      // the frozen geometry (the R4 teleport flake documented in ExportDialog.tsx). Wait for the
      // inline geometry before reading either the moved box or the resize handle.
      await expect.poll(async () => (await surface.getAttribute('style')) ?? '').toContain('left:')

      const moved = (await surface.boundingBox())!
      // Delta-exact, not just "moved somewhere": a earlier version of this suite only asserted
      // "less than", which the (0,0) teleport bug also satisfied — that is how it slipped through.
      // Both axes clamp at the viewport edges (left/top), so the expected position is clamp-aware.
      expect(Math.abs(moved.x - Math.max(0, before.x - 120))).toBeLessThanOrEqual(2)
      expect(Math.abs(moved.y - Math.max(0, before.y - 60))).toBeLessThanOrEqual(2)

      // Resize from the SE corner: grow both width and height.
      const se = dialog.getByTestId('export-dialog-resize-se')
      const sb = (await se.boundingBox())!
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
      await page.mouse.down()
      await page.mouse.move(sb.x + sb.width / 2 + 120, sb.y + sb.height / 2 + 90, { steps: 6 })
      await page.mouse.up()

      // Auto-retrying assertions: a late React commit must not masquerade as a broken resize.
      // On failure, attach the geometry and pointer counters so the next occurrence is diagnosable.
      try {
        await expect
          .poll(async () => (await surface.boundingBox())?.width ?? 0)
          .toBeGreaterThan(moved.width)
        await expect
          .poll(async () => (await surface.boundingBox())?.height ?? 0)
          .toBeGreaterThan(moved.height)
      } catch (error) {
        const diagnostics = await page.evaluate(() => {
          const w = window as any
          const el = document.querySelector('[role="dialog"]')
          return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            dialogStyle: el?.getAttribute('style') ?? null,
            pointerCounts: w.__r4Pointers ?? null,
          }
        })
        // `body` attachments live only in the result object; a `path` attachment is copied into
        // test-results/attachments/, which CI uploads as an artifact.
        const info = test.info()
        const file = info.outputPath('export-dialog-geometry.json')
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(diagnostics, null, 2), 'utf-8')
        await info.attach('export-dialog-geometry', {
          path: file,
          contentType: 'application/json',
        })
        throw error
      }

      // All eight resize handles are present and focusable (keyboard parity).
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const handleEl = dialog.getByTestId(`export-dialog-resize-${dir}`)
        await expect(handleEl).toBeVisible()
        await expect(handleEl).toHaveAttribute('role', 'separator')
      }

      await closeDialog(page, dialog)
    } finally {
      await page.evaluate(() => {
        const w = window as any
        for (const [name, handler] of Object.entries(w.__r4Handlers ?? {})) {
          window.removeEventListener(name, handler as EventListener, true)
        }
        delete w.__r4Handlers
        delete w.__r4Pointers
      })
      // A failed assertion must not leave the modal open for the next case in this file.
      if (await dialog.isVisible().catch(() => false)) {
        await dialog
          .getByText('Cancel')
          .click({ timeout: 1000 })
          .catch(() => {})
      }
    }
  })

  // R4 teleport regression (user report 2026-11-12): a bare pointerdown on a resize edge used to
  // TELEPORT the dialog. First the rect-set branch carried `!left-0 !top-0` important utilities,
  // which beat the inline coordinates and pinned it to (0,0); after dropping them, the base
  // `translate: -50% -50%` utility (Tailwind v4 compiles translate utilities to the CSS `translate`
  // property, which `transform: none` does NOT clear) shifted it by half its own size. Freezing the
  // geometry into `rect` must be visually a no-op, and a west drag must grow leftward with the
  // RIGHT edge pinned.
  test('a pointerdown on a resize edge never moves the dialog (R4 teleport regression)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const { dialog } = await openExportPreview(page)
    const before = (await dialog.boundingBox())!

    // 1) Bare click (down+up, no movement) on the west edge.
    const edge = dialog.getByTestId('export-dialog-resize-w')
    const eb = (await edge.boundingBox())!
    const cx = eb.x + eb.width / 2
    const cy = eb.y + eb.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.up()
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    )
    const clicked = (await dialog.boundingBox())!
    expect(Math.abs(clicked.x - before.x), 'bare edge click must not move x').toBeLessThanOrEqual(2)
    expect(Math.abs(clicked.y - before.y), 'bare edge click must not move y').toBeLessThanOrEqual(2)
    expect(
      Math.abs(clicked.width - before.width),
      'bare edge click must not resize',
    ).toBeLessThanOrEqual(2)

    // 2) A real west drag: grows leftward, right edge pinned.
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 30, cy, { steps: 4 })
    await page.mouse.up()
    const grown = (await dialog.boundingBox())!
    expect(grown.width).toBeCloseTo(clicked.width + 30, 0)
    expect(grown.x + grown.width).toBeCloseTo(clicked.x + clicked.width, 0)

    await closeDialog(page, dialog)
  })

  // R4 bounds regression (user report 2026-11-12): the dialog used to overflow the app window on
  // short viewports (the base DialogContent has no max-height, so the content height decided) and
  // poked a few px past the bottom even after clamping, because the slide-up entry animation's
  // transform offset can freeze mid-flight in a throttled renderer while the dialog is exactly
  // viewport-tall. The default state must always fit inside the app window.
  test('the export dialog opens fully inside the app window on a short viewport (R4 bounds)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    try {
      await page.setViewportSize(VIEWPORTS.short)
      await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(600)
      const { dialog } = await openExportPreview(page)
      const vw = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      // Let the entry animation settle, then require containment; if it never settles, the poll
      // times out and the hard asserts below report the residual offset.
      await expect
        .poll(async () => {
          const b = (await dialog.boundingBox())!
          return Math.round(b.y + b.height) - vw.h
        })
        .toBeLessThanOrEqual(0)
      const box = (await dialog.boundingBox())!
      expect(box.x, 'left edge inside').toBeGreaterThanOrEqual(0)
      expect(box.y, 'top edge inside').toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, 'right edge inside').toBeLessThanOrEqual(vw.w)
      expect(box.y + box.height, 'bottom edge inside').toBeLessThanOrEqual(vw.h)
      await closeDialog(page, dialog)
    } finally {
      await page.setViewportSize(VIEWPORTS.standard)
    }
  })

  // R4 (user report 2026-11-12, "the top strip could not be dragged"): DialogContent's `p-6` used to put
  // the title row 24px below the border, and the drag handler lived ONLY on that row. The band
  // between the 8px N resize handle and the title was dead — measured dx=0 for y=10/14/18/22.
  // The header hit area now covers the container padding, so the whole strip drags like a real
  // title bar, while the topmost 8px still resizes from the north edge.
  test('the whole top strip of the export dialog drags like a title bar (R4)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    const { dialog } = await openExportPreview(page)
    const vw = await page.evaluate(() => window.innerWidth)

    for (const dy of [10, 16, 22]) {
      const box = (await dialog.boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + dy
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 40, y + 20, { steps: 4 })
      await page.mouse.up()
      const after = (await dialog.boundingBox())!
      expect(
        Math.abs(after.x - Math.min(box.x + 40, vw - box.width)),
        `top strip y+${dy} must move the dialog`,
      ).toBeLessThanOrEqual(2)
      expect(
        Math.abs(after.width - box.width),
        `top strip y+${dy} must not resize`,
      ).toBeLessThanOrEqual(2)
    }

    // The 8px N handle must STILL resize from the top edge — covering it with the drag area
    // would silently remove north resizing.
    const beforeN = (await dialog.boundingBox())!
    const nx = beforeN.x + beforeN.width / 2
    const ny = beforeN.y + 3
    await page.mouse.move(nx, ny)
    await page.mouse.down()
    await page.mouse.move(nx, ny + 20, { steps: 4 })
    await page.mouse.up()
    const afterN = (await dialog.boundingBox())!
    expect(afterN.height, 'N handle must still shrink the height from the top').toBeLessThan(
      beforeN.height,
    )

    await closeDialog(page, dialog)
  })

  // R5 (user report 2026-11-13, "a print-preview sub-window still flashed by and vanished"): the owner BrowserWindow is
  // created with show:false but was shown BEFORE setOpacity(0). Electron emits `show` with the
  // window still fully opaque, so one painted frame of an 800x600 window was visible in the top
  // left corner before it turned transparent. There is no OS print dialog in this test: the
  // webContents.print stub resolves the production callback immediately, which keeps the loop
  // deterministic and fast while still driving the real `export:print` IPC path.
  test('the print owner window is transparent from its first visible frame (no flash)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)

    await electronApp.evaluate(({ app }: any) => {
      const p: any = { events: [], win: null, listener: null }
      ;(globalThis as any).__printProbe = p
      p.listener = (_e: any, win: any) => {
        p.win = win
        win.on('show', () => p.events.push({ event: 'show', opacity: win.getOpacity() }))
        const wc = win.webContents as any
        wc.print = (_opts: any, cb: any) => {
          if (typeof cb === 'function') cb(true)
        }
      }
      app.on('browser-window-created', p.listener)
    })

    try {
      // Deliberately not awaited: if the stub ever stops landing, the OS dialog would block and
      // this test must still be able to clean up the owner window instead of hanging the suite.
      await page.evaluate(() => {
        void (window as any).api.export.print('<html><body>print probe</body></html>')
      })
      const readShows = async () =>
        await electronApp.evaluate(
          () =>
            ((globalThis as any).__printProbe?.events ?? []).filter(
              (e: any) => e.event === 'show',
            ) as Array<{ opacity: number }>,
        )
      await expect.poll(async () => (await readShows()).length).toBeGreaterThan(0)
      const shows = await readShows()
      expect(
        shows.map((s) => s.opacity),
        'opacity at the `show` event',
      ).toEqual(shows.map(() => 0))
    } finally {
      await electronApp.evaluate(({ app }: any) => {
        const p = (globalThis as any).__printProbe
        if (p?.listener) app.removeListener('browser-window-created', p.listener)
        if (p?.win && !p.win.isDestroyed()) p.win.destroy()
        delete (globalThis as any).__printProbe
      })
    }
  })

  // R4 follow-up (user report 2026-11-13, "filled the whole window on open…leave space top and bottom…centered in the main window"):
  // the preview pane's `min-h-[40vh]` made the dialog height == 40vh + ~345px of fixed content,
  // so it filled 85% of a 768px window and 98.6% of a 560px one (4px of headroom). The dialog now
  // owns its height (88vh, capped at 960px so a 1440px window does not dwarf it) and the guard
  // below pins those numbers. Measured at three named environments, because a single viewport
  // cannot catch a vh-proportional regression.
  test('the export dialog is centered with breathing room on every viewport', async () => {
    const { page } = handle
    await waitForAppReady(page)
    try {
      const { dialog } = await openExportPreview(page)
      // Capping the dialog must not collapse the preview into nothing: the shadow host still owns
      // the remaining flex space and scrolls internally.
      const hostBox = await dialog.getByTestId('export-preview').boundingBox()
      expect(hostBox?.height ?? 0, 'the export preview stays usable').toBeGreaterThan(150)
      const measure = () =>
        dialog.evaluate((el: any) => {
          const r = el.getBoundingClientRect()
          return {
            top: r.top,
            bottom: r.bottom,
            hPct: (r.height / window.innerHeight) * 100,
            centerDx: (r.left + r.right) / 2 - window.innerWidth / 2,
            centerDy: (r.top + r.bottom) / 2 - window.innerHeight / 2,
            vh: window.innerHeight,
          }
        })

      // Each environment is ENTERED by name: e2e/guards/viewports.test.ts scans the spec text and
      // rejects any viewport call whose argument is not a literal VIEWPORTS.<name>, so a loop over
      // the names cannot be used here (not even inside a comment).
      const assertGeometry = async (name: string, height: number) => {
        await expect.poll(async () => (await measure()).vh).toBe(height)
        const g = await measure()
        expect(g.hPct, `${name}: height must stay below 89% of the window`).toBeLessThanOrEqual(89)
        expect(g.top, `${name}: top breathing room`).toBeGreaterThanOrEqual(g.vh * 0.06 - 1)
        expect(g.vh - g.bottom, `${name}: bottom breathing room`).toBeGreaterThanOrEqual(
          g.vh * 0.06 - 1,
        )
        expect(Math.abs(g.centerDx), `${name}: horizontally centered`).toBeLessThanOrEqual(2)
        expect(Math.abs(g.centerDy), `${name}: vertically centered`).toBeLessThanOrEqual(2)
      }
      await page.setViewportSize(VIEWPORTS.standard)
      await assertGeometry('standard', VIEWPORTS.standard.height)
      await page.setViewportSize(VIEWPORTS.short)
      await assertGeometry('short', VIEWPORTS.short.height)
      await page.setViewportSize(VIEWPORTS.baseline)
      await assertGeometry('baseline', VIEWPORTS.baseline.height)
      await page.setViewportSize(VIEWPORTS.standard)
      await closeDialog(page, dialog)
    } finally {
      await page.setViewportSize(VIEWPORTS.standard)
    }
  })

  // Modal anatomy regression (user report 2026-11-13): the inline-images checkbox, the target path
  // and the actions used to share ONE scroll region with the preview, so a long document pushed
  // them out of view. They are now pinned in a footer that never scrolls. Proven in the worst
  // case — the SHORT viewport, where the demo document's preview definitely overflows — by
  // asserting every option sits fully inside the dialog's bounds without any scrolling.
  test('the export options stay pinned in the footer while the preview overflows', async () => {
    const { page } = handle
    await waitForAppReady(page)
    try {
      await page.setViewportSize(VIEWPORTS.short)
      const { dialog } = await openExportPreview(page)
      // Worst case achieved: the preview content is taller than the stage, i.e. the situation
      // that used to push the options out of view.
      await expect
        .poll(async () =>
          dialog.evaluate((el: any) => {
            const p = el.querySelector('[data-testid="export-preview"]')
            return p ? p.scrollHeight - p.clientHeight : 0
          }),
        )
        .toBeGreaterThan(0)
      // The Export action reads its label from the store's readiness mirror; pin it so the
      // assertion below targets the button by its settled name.
      await page.evaluate(() => (window as any).__uiStore.getState().setExportReady(true))

      const inside = async (locator: any, label: string) => {
        const b = (await locator.boundingBox())!
        const d = (await dialog.boundingBox())!
        expect(b.y, `${label}: fully inside the dialog (top)`).toBeGreaterThanOrEqual(d.y)
        expect(b.y + b.height, `${label}: fully inside the dialog (bottom)`).toBeLessThanOrEqual(
          d.y + d.height,
        )
        expect(b.x, `${label}: fully inside the dialog (left)`).toBeGreaterThanOrEqual(d.x)
        expect(b.x + b.width, `${label}: fully inside the dialog (right)`).toBeLessThanOrEqual(
          d.x + d.width,
        )
        await expect(locator).toBeVisible()
      }
      await inside(dialog.locator('input[type="checkbox"]'), 'inline-images checkbox')
      await inside(dialog.locator('input[readonly]'), 'target path')
      await inside(dialog.getByText('Choose…'), 'choose button')
      await inside(dialog.getByRole('button', { name: 'Export' }), 'export button')
      await closeDialog(page, dialog)
    } finally {
      await page.setViewportSize(VIEWPORTS.standard)
    }
  })
})
