// REPRO spec (diagnosis loop, 2026-09-17) — goes red on the three user-reported bugs:
//   1. Ctrl+A inside the preview selects BOTH panes (should scope to the preview article).
//   2. Ctrl+A inside the editor selects only part of the document (should select all).
//   3. Rich-text copy from the preview loses mermaid / table borders / code colors /
//      blockquote styling / fonts (payload is bare semantic HTML with no styles).
// Each test asserts the DESIRED post-fix behavior, so it is red now and green once fixed.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '../helpers/temp'

// A 1x1 transparent PNG (the same fixture the export handler's unit tests use) so the "local
// image" e2e case needs no binary asset in the repo.
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082'

test.describe('select-all scoping + rich-copy fidelity (bug repros)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-repro-')
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  async function openDoc(page: Page, content: string): Promise<string> {
    const file = join(scratch, `doc-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
    writeFileSync(file, content, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    expect(id).toBeTruthy()
    await page.evaluate((docId) => {
      const w = window as any
      w.__uiStore.getState().setActiveDocumentId(docId)
      w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
    }, id)
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.locator('.markdown-preview')).toBeVisible()
    return id
  }

  // BUG 1 — Ctrl+A in the preview pane must scope the selection to the preview article.
  test('preview: Ctrl+A scopes the selection to the preview article', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Title\n\nfirst paragraph\n\nsecond paragraph\n')
    // SPLIT view: both panes mounted — this is where the cross-pane select-all shows.
    await page.getByTestId('view-split').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // Put the caret inside the preview, then Ctrl+A.
    await article.locator('p').first().click()
    await page.keyboard.press('Control+a')
    // Wait for the scoped select-all to land (guards against reading a stale caret).
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('first paragraph')
    // The selection anchor must live INSIDE the preview article, not on the document body.
    const where = await page.evaluate(() => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return { inArticle: false, textLen: 0 }
      const node = sel.anchorNode
      const inArticle = !!node && !!(node as Element).closest?.('article.markdown-preview')
      // also accept a text node whose parent is inside the article
      const parentEl = node && node.nodeType === 3 ? node.parentElement : (node as Element | null)
      const inArticleText = !!parentEl && !!parentEl.closest?.('article.markdown-preview')
      return {
        inArticle: inArticle || inArticleText,
        textLen: sel.toString().length,
      }
    })
    expect(where.inArticle).toBe(true)
    // The selection must hold the preview text (all paragraphs) and must NOT contain any
    // editor-source-only marker ('#') — i.e. the editor pane was not swept into it.
    const selText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(selText).toContain('first paragraph')
    expect(selText).toContain('second paragraph')
    expect(selText).not.toContain('#')
  })

  // BUG 2 — Ctrl+A in the editor must select the ENTIRE editor document.
  test('editor: Ctrl+A selects the whole editor document', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, 'alpha line\nbeta line\ngamma line\n')
    // Cursor into the middle line first.
    await page.locator('.cm-content').click()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Control+a')
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('gamma line')
    const sel = await page.evaluate(() => {
      const s = window.getSelection()
      const node = s?.anchorNode ?? null
      const el = node && node.nodeType === 3 ? node.parentElement : (node as Element | null)
      return {
        inEditor: !!el?.closest?.('.cm-content'),
        text: s?.toString() ?? '',
      }
    })
    expect(sel.inEditor).toBe(true)
    expect(sel.text).toContain('alpha line')
    expect(sel.text).toContain('beta line')
    expect(sel.text).toContain('gamma line')
  })

  // Real-user Ctrl+A does NOT reach the renderer as a keydown: the native menu's
  // CmdOrCtrl+A accelerator intercepts it (this is why page.keyboard alone cannot see the
  // bug — CDP-injected keys bypass menu accelerators). The accelerator now fires the
  // 'select-all' menu item, so driving that item IS the real-user path. The renderer's
  // selectAllRouter must pick the focused pane.
  test('editor: the menu select-all item selects the whole CodeMirror document', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(page, 'alpha line\nbeta line\ngamma line\n')
    await page.locator('.cm-content').click()
    await page.keyboard.press('ArrowUp')
    // Trigger the REAL menu item — exactly what the Ctrl+A accelerator executes.
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('select-all')?.click()
    })
    // The routed select-all arrives over IPC — wait for it to land before reading the
    // selection (reading immediately races the IPC and sees the pre-click caret).
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('alpha line')
    const sel = await page.evaluate(() => {
      const s = window.getSelection()
      const node = s?.anchorNode ?? null
      const el = node && node.nodeType === 3 ? node.parentElement : (node as Element | null)
      return { inEditor: !!el?.closest?.('.cm-content'), text: s?.toString() ?? '' }
    })
    expect(sel.inEditor).toBe(true)
    expect(sel.text).toContain('alpha line')
    expect(sel.text).toContain('gamma line')
  })

  test('preview: the menu select-all item scopes the selection to the preview article', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Title\n\nfirst paragraph\n\nsecond paragraph\n')
    await page.getByTestId('view-split').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    await article.locator('p').first().click()
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('select-all')?.click()
    })
    // The menu click routes through IPC — wait until the routed select-all has landed
    // (the collapsed caret from the click becomes a full article selection).
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('first paragraph')
    const where = await page.evaluate(() => {
      const sel = window.getSelection()
      const node = sel?.anchorNode ?? null
      const el = node && node.nodeType === 3 ? node.parentElement : (node as Element | null)
      return { inArticle: !!el?.closest?.('article.markdown-preview'), text: sel?.toString() ?? '' }
    })
    expect(where.inArticle).toBe(true)
    expect(where.text).toContain('second paragraph')
    expect(where.text).not.toContain('#')
  })

  // Ctrl+A while a right-click menu is open: the menu must be DISMISSED first and the
  // select-all must then act on the pane the menu belonged to (its Radix trigger owns the
  // focus again once the menu unmounts) — never on the menu itself.
  test('menu select-all dismisses an open context menu then acts on the pane behind it', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Title\n\nfirst paragraph\n\nsecond paragraph\n')
    await page.getByTestId('view-split').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    // Open the preview's context menu (right-click a paragraph).
    await article.locator('p').first().click({ button: 'right' })
    await expect(page.getByTestId('preview-copy')).toBeVisible()
    // Ctrl+A (routed through the app menu) while the menu is open.
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('select-all')?.click()
    })
    // 1) the menu is gone…
    await expect(page.getByTestId('preview-copy')).toHaveCount(0)
    // 2) …and the selection landed in the preview pane behind it.
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain('first paragraph')
    const where = await page.evaluate(() => {
      const sel = window.getSelection()
      const node = sel?.anchorNode ?? null
      const el = node && node.nodeType === 3 ? node.parentElement : (node as Element | null)
      return { inArticle: !!el?.closest?.('article.markdown-preview'), text: sel?.toString() ?? '' }
    })
    expect(where.inArticle).toBe(true)
    expect(where.text).toContain('second paragraph')
  })

  // ADR 0019 — the copy payload must carry the diagram at all. D-E① moved mermaid baking
  // out of the HTML string, which made a whole-article copy come out as empty placeholders.
  //
  // Plan 04 (D13) upgraded this further: the diagram must arrive as a RASTERIZED PNG, not the
  // inline `<svg>` this test originally asserted (Word does not render inline SVG — plan 04
  // §2.2 F3). Rasterization is async, so the copy is polled until the PNG lands.
  test('preview: menu Copy carries the mermaid diagram as a PNG (ADR 0019 + D13)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(page, '# T\n\nA paragraph.\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n')

    // The diagram is baked in the preview… (preview mermaid bakes lazily via IntersectionObserver,
    // so scroll the slot into view first — it would not bake while below the fold on a short window).
    await page.locator('[data-mermaid-slot="0"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="0"] svg')).toBeVisible({ timeout: 30_000 })

    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    let html = ''
    await expect
      .poll(
        async () => {
          await article.locator('p').first().click({ button: 'right' })
          await page.getByTestId('preview-copy').click()
          html = await readClip()
          return /<img[^>]+alt="diagram"/i.test(html)
        },
        { timeout: 25_000 },
      )
      .toBe(true)

    // …so it must be in the clipboard payload too (as the Word-safe PNG, markers stripped).
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/i)
    expect(html).not.toContain('data-mermaid-slot')
  })

  // BUG 3 — menu Copy must land a styled, Word-ready payload.
  // Plan 04 (docs.local/plan-preview-refactor-04-copy-fidelity) is implemented: the payload must
  // carry the diagram as a RASTERIZED PNG (Word cannot render inline <svg>), inline borders on
  // table/code, inline hljs token colors and a styled blockquote.
  //
  // NOTE: the previous version of this test accepted EITHER `<svg>` OR a data-URL image, so it
  // stayed green while rasterization was completely broken (a blob: src blocked by the app CSP)
  // and diagrams pasted as unusable SVG text. It now requires the PNG.
  test('preview: menu Copy carries a mermaid PNG, borders, code colors and blockquote styles', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(
      page,
      [
        '# Fidelity',
        '',
        '> a quoted thought',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '```js',
        'const x = 1',
        '```',
        '',
        '```mermaid',
        'graph TD',
        '  A[Start] --> B[End]',
        '```',
        '',
      ].join('\n'),
    )
    // Wait for the real mermaid SVG to render. The preview bakes mermaid lazily via
    // IntersectionObserver, so scroll slot 0 into view first — on a short/narrow split pane it can
    // sit below the fold and the lazy render would never fire (same class of flake as the
    // diagrams.md test below).
    await page.locator('[data-mermaid-slot="0"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="0"] svg')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    // Read the REAL system clipboard back from the main process (Electron 44 API).
    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })
    // Right-click a blockquote → generic menu → Copy.
    const menuCopy = async (): Promise<string> => {
      await article.locator('blockquote').click({ button: 'right' })
      await page.getByTestId('preview-copy').click()
      return readClip()
    }

    // Rasterization is async (canvas); poll until the copy carries the diagram PNG.
    let html = ''
    await expect
      .poll(
        async () => {
          html = await menuCopy()
          return /<img[^>]+alt="diagram"/i.test(html)
        },
        { timeout: 25_000 },
      )
      .toBe(true)

    // The diagram must be a bitmap, not inline <svg> (this doc has no math, so no KaTeX SVG).
    expect(html).not.toMatch(/<svg[\s>]/i)
    // Tables must carry visible borders inline (Word applies no external CSS).
    expect(html).toMatch(/<(td|th)[^>]*style="[^"]*border/i)
    // Code blocks must keep borders/background inline…
    expect(html).toMatch(/<pre[^>]*style="[^"]*(border|background-color)/i)
    // …and real syntax-token colors (highlight.js class + inline color).
    expect(html).toMatch(/<span class="hljs-[^"]*"[^>]*style="[^"]*color:/i)
    // Blockquotes must keep their left rule / background inline.
    expect(html).toMatch(/<blockquote[^>]*style="[^"]*(border|background)/i)
  })

  // Regression for the user-reported demo case: copying the demo document (e2e/fixtures/
  // preview-render-pipeline/diagrams.md — a self-contained English copy of examples/demo.en.md,
  // 4 mermaid diagrams + highlighted code) must keep EVERY diagram (as a PNG) and every token
  // color — not drop diagrams (empty placeholders) and not paste them as inline <svg>.
  // Window-pinned (small-window) guard: pinned to the minimum allowed size (minWidth 800 /
  // minHeight 600) so copy fidelity is verified under the exact short/narrow split-pane condition
  // that made this test flake on CI — slot 0 starts below the preview fold and must bake via scroll
  // before menu Copy can rasterize all four diagrams.
  test('preview: menu Copy of the demo document keeps every diagram as a PNG', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await page.setViewportSize({ width: 800, height: 600 })
    await openDoc(
      page,
      readFileSync(join('e2e', 'fixtures', 'preview-render-pipeline', 'diagrams.md'), 'utf-8'),
    )
    // The preview renders mermaid lazily via IntersectionObserver (MarkdownPreview.tsx), so a
    // slot only bakes once it scrolls into view. The wide demo table before slot 0 pushes it below
    // the (short, narrow) split-pane fold on CI's smaller window, so scroll it into view first —
    // otherwise the lazy render never fires and this assertion times out (it passed locally only
    // because the taller local window happened to keep slot 0 on-screen).
    await page.locator('[data-mermaid-slot="0"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="0"] svg')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })
    const menuCopy = async (): Promise<string> => {
      await article.locator('p').first().click({ button: 'right' })
      await page.getByTestId('preview-copy').click()
      return readClip()
    }

    let html = ''
    await expect
      .poll(
        async () => {
          html = await menuCopy()
          // The demo has 4 mermaid diagrams; all must arrive as PNG images (alt="diagram").
          return (html.match(/<img[^>]+alt="diagram"/gi) || []).length >= 4
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    // No diagram is left as inline SVG or as an empty placeholder.
    expect(html).not.toMatch(/id="mermaid-/i)
    expect(html).not.toContain('data-mermaid-slot')
    // Code token colors survive.
    expect(html).toMatch(/<span class="hljs-[^"]*"[^>]*style="[^"]*color:/i)
  })

  // R13.9 / D17 (corrected 2026-09-21) — math rides its MathML carrier, it is NOT rasterized.
  // KaTeX has no SVG output mode (its `output` enum is htmlAndMathml|html|mathml), so the rejected
  // "rasterize the formula" design could never have worked; what actually reaches Word / OneNote
  // (both verified manually) is the MathML branch KaTeX emits next to its HTML. This guards the
  // carrier itself: a KaTeX output-mode change, a sanitizer allowlist tightening or a DOM
  // re-serialization would silently drop <math> and leave only KaTeX's HTML spans, which no target
  // app can render — the same "silent failure" pattern this plan hit twice already.
  test('preview: menu Copy keeps the MathML carrier for formulas (R13.9 / D17)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(
      page,
      ['# Math', '', 'Inline $E = mc^2$ here.', '', '$$\\int_0^1 x^2\\,dx$$', ''].join('\n'),
    )
    // Both formulas must have been really rendered by KaTeX (the MathML layer carries the TeX).
    await expect(page.locator('.markdown-preview .katex').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    let html = ''
    await expect
      .poll(
        async () => {
          await article.locator('p').first().click({ button: 'right' })
          await page.getByTestId('preview-copy').click()
          html = await readClip()
          return /<math[\s>]/i.test(html)
        },
        { timeout: 25_000 },
      )
      .toBe(true)

    // The inline AND the display formula keep their TeX annotation…
    expect((html.match(/<math[\s>]/gi) || []).length).toBeGreaterThanOrEqual(2)
    expect(html).toMatch(/annotation[^>]*application\/x-tex/i)
    // …and no formula was swapped for a bitmap: a picture pastes into Word as an image, not as an
    // editable equation (the old `alt` was the TeX source, which always contains a caret).
    expect(html).not.toMatch(/<img[^>]+alt="[^"]*\^/i)
  })

  // D16 — the payload must be LIGHT whatever the app theme is: a dark preview pasting grey-on-grey
  // is exactly what forceLight prevents. Self-calibrating on purpose: the expectation is read from
  // the preview's own computed style per theme, so a github-markdown-css bump cannot make this test
  // pass vacuously (it would simply follow the new values).
  test('preview: the copy payload stays light while the app is dark (D16)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Heading\n\nbody copy\n\n```js\nconst x = 1\n```\n')
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()
    await expect(article.locator('pre')).toBeVisible()

    // The code-block background is element-level (not inherited), so the fidelity walk inlines it —
    // it is the cleanest per-theme probe of "which stylesheet did the payload actually read?".
    const readPreBackground = async (): Promise<string> =>
      page.evaluate(() => {
        const pre = document.querySelector('article.markdown-preview pre')
        return pre ? getComputedStyle(pre).backgroundColor : ''
      })
    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })
    const menuCopy = async (): Promise<string> => {
      await article.locator('p').first().click({ button: 'right' })
      await page.getByTestId('preview-copy').click()
      return readClip()
    }

    const lightBackground = await readPreBackground()
    expect(lightBackground).not.toBe('')
    let lightHtml = ''
    await expect
      .poll(
        async () => {
          lightHtml = await menuCopy()
          return lightHtml.includes(lightBackground)
        },
        { timeout: 25_000 },
      )
      .toBe(true)

    // Switch the app to dark: the PREVIEW turns dark…
    await page.evaluate(() => {
      const w = window as any
      w.__uiStore.getState().setTheme('dark')
    })
    await expect.poll(readPreBackground).not.toBe(lightBackground)
    const darkBackground = await readPreBackground()

    // …while the payload stays light — it is inlined from the offscreen light host (D16)…
    let darkHtml = ''
    await expect
      .poll(
        async () => {
          darkHtml = await menuCopy()
          return darkHtml.includes(lightBackground)
        },
        { timeout: 25_000 },
      )
      .toBe(true)
    expect(darkHtml).not.toContain(darkBackground)
    // …and is byte-identical to the light-theme payload: the app theme never leaks into the clipboard.
    expect(darkHtml).toBe(lightHtml)
  })

  // R13.7 / plan-02 R3 — the OTHER half of the contract. Every other copy case in this spec drives
  // the right-click menu (which prepares a pending payload asynchronously); the keyboard Ctrl+C path
  // has no pending payload and builds its fragment live, i.e. it is a genuinely different code path
  // that must not diverge. This one presses the real keys and compares the two payloads.
  test('preview: keyboard Ctrl+C carries the same fidelity payload as the menu (R13.7)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(
      page,
      [
        '# Fidelity',
        '',
        'intro paragraph',
        '',
        '> a quoted thought',
        '',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '```js',
        'const x = 1',
        '```',
        '',
      ].join('\n'),
    )
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    // Real keys: click into the preview (focus) → the preview's own Ctrl+A → Ctrl+C.
    await article.locator('p').first().click()
    await page.keyboard.press('Control+a')
    let keyboardHtml = ''
    await expect
      .poll(
        async () => {
          await page.keyboard.press('Control+c')
          keyboardHtml = await readClip()
          return keyboardHtml.length > 0
        },
        { timeout: 25_000 },
      )
      .toBe(true)

    expect(keyboardHtml).toMatch(/<(td|th)[^>]*style="[^"]*border/i)
    expect(keyboardHtml).toMatch(/<blockquote[^>]*style="[^"]*(border|background)/i)
    expect(keyboardHtml).toMatch(/<span class="hljs-[^"]*"[^>]*style="[^"]*color:/i)
    expect(keyboardHtml).not.toContain('data-line')

    // …and it does not diverge from the menu path: right-click INSIDE the (still active) selection
    // so the menu copies the same fragment, then compare byte for byte.
    await article.locator('blockquote').click({ button: 'right' })
    await expect(page.getByTestId('preview-copy')).toBeVisible()
    await page.getByTestId('preview-copy').click()
    const menuHtml = await readClip()
    expect(menuHtml).toBe(keyboardHtml)
  })

  // §4.8b — the keyboard path must inline images of a PARTIAL SELECTION too. That path has no
  // pending payload (no embedImages call), so the fragment's own appdoc:// sources are rewritten
  // from the src → data: map warmInlinedImages produced. Without it the paste shows a broken image.
  test('preview: keyboard copy of a selection inlines the local image (§4.8)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    writeFileSync(join(scratch, 'pic.png'), Buffer.from(PNG_HEX, 'hex'))
    await openDoc(page, '# Img\n\nintro\n\n![pic](pic.png)\n\nafter\n')
    await expect(page.locator('article.markdown-preview img')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    let html = ''
    await expect
      .poll(
        async () => {
          // Focus the preview article (so the copy event targets it), then select ONLY the image
          // and copy it with the keyboard — no menu, no pending payload.
          await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>('article.markdown-preview')
            root?.focus()
            const img = document.querySelector('article.markdown-preview img')
            if (!root || !img) return
            const range = document.createRange()
            range.selectNode(img)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          })
          await page.keyboard.press('Control+c')
          html = await readClip()
          return html.includes('data:image/png;base64,')
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    // The local image was embedded, not left as an appdoc:// URL the target app cannot load.
    expect(html).not.toContain('appdoc://')
  })

  // D13 (revised 2026-09-21) — the diagram must arrive as a HIGH-RES bitmap whose display size is
  // pinned to the diagram's CSS size. Regression this guards: the payload used to carry a 110×300
  // bitmap for a diagram shown at 181×499 (the rasterizer trusted `naturalWidth`, which is the
  // browser's 300×150 default for mermaid's `width="100%"` + viewBox SVGs), so pasted diagrams were
  // both blurry and too small.
  test('preview: menu Copy carries the diagram as a high-res bitmap at its display size (D13)', async () => {
    const { page, electronApp } = handle
    await waitForAppReady(page)
    await openDoc(page, '# T\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n')
    const svg = page.locator('[data-mermaid-slot="0"] svg')
    // Preview mermaid bakes lazily via IntersectionObserver; scroll into view so it bakes even
    // when it starts below the fold on a short window.
    await svg.scrollIntoViewIfNeeded()
    await expect(svg).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-preview').click()
    const article = page.locator('.markdown-preview')
    await expect(article).toBeVisible()

    // The size the diagram occupies in the preview (what the pasted image should look like).
    const display = await page.evaluate(() => {
      const el = document.querySelector('[data-mermaid-slot="0"] svg')
      if (!el) return { width: 0, height: 0 }
      const r = el.getBoundingClientRect()
      return { width: Math.round(r.width), height: Math.round(r.height) }
    })
    expect(display.width).toBeGreaterThan(10)

    const readClip = async (): Promise<string> =>
      electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items[0]
        if (!item || !item.types.includes('text/html')) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })

    let html = ''
    await expect
      .poll(
        async () => {
          await article.locator('h1').first().click({ button: 'right' })
          await page.getByTestId('preview-copy').click()
          html = await readClip()
          return /<img[^>]+alt="diagram"/i.test(html)
        },
        { timeout: 25_000 },
      )
      .toBe(true)

    const tag = (html.match(/<img[^>]+alt="diagram"[^>]*>/) ?? [''])[0]
    // ① the display size is pinned to the diagram's CSS size (creates the "right size" in Word)…
    const shownWidth = Number((tag.match(/width="(\d+)"/) ?? [])[1])
    const shownHeight = Number((tag.match(/height="(\d+)"/) ?? [])[1])
    expect(shownWidth).toBeGreaterThanOrEqual(display.width - 2)
    expect(shownWidth).toBeLessThanOrEqual(display.width + 2)
    expect(shownHeight).toBeGreaterThanOrEqual(display.height - 2)
    expect(shownHeight).toBeLessThanOrEqual(display.height + 2)
    // ② …and the bitmap behind it has at least 2× those pixels (creates the "crisp").
    const base64 = (tag.match(/base64,([^"]+)/) ?? [])[1]!
    const png = Buffer.from(base64, 'base64')
    const pxWidth = png.readUInt32BE(16) // PNG IHDR width
    const pxHeight = png.readUInt32BE(20) // PNG IHDR height
    // 2× is now the EXACT scale, so allow 1px of rounding slack between the intrinsic and the
    // rendered (Math.round'd) display width — without it the assertion can flake by one pixel.
    expect(pxWidth).toBeGreaterThanOrEqual(display.width * 2 - 1)
    expect(pxHeight).toBeGreaterThanOrEqual(display.height * 2 - 1)
  })
})
