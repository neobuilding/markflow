import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, AppHandle } from '../helpers/launch'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkTempDir } from '../helpers/temp'

// Self-contained test data: a committed copy of examples/demo.en.md (4 mermaid diagrams)
// lives under e2e/fixtures so this spec never depends on the examples/ tree.
const DIAGRAM_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'preview-render-pipeline',
  'diagrams.md',
)

// Plan 01 stage 1 (preview render-pipeline refactor) — real-renderer acceptance.
//
// The unit suite proves the pipeline and the DOM patcher in isolation, but only the real
// Electron renderer proves the END-TO-END shape produced by markdown-it → sanitize → patch:
//
//   R6 — every top-level block carries a `data-line` source mapping
//   P8 — the preview <article> holds the content DIRECTLY (the old SafeHtml wrapper <div> is gone)
//
// (R4 incremental patch / R5 single sanitization are behavioural and are covered by the unit
// suite; the existing preview e2e specs — mermaid/katex/context-menu/save-export — would fail
// loudly if the DOM shape or the mermaid baking broke, e.g. this suite is what catches a bad
// `data-mermaid-slot` placeholder shape that stops the SVG from being baked in.)
test.describe('preview render pipeline (Plan 01 stage 1)', () => {
  let handle: AppHandle
  let scratch: string

  test.beforeEach(async () => {
    handle = await launchApp()
    scratch = mkTempDir('markflow-e2e-')
  })

  test.afterEach(async () => {
    await closeApp(handle)
  })

  // Write the document to disk and open it through the real import IPC + UI store, so the
  // preview renders the real pipeline output (same approach as mermaid-preview.e2e.spec.ts).
  // `editable` also flips the UI store's editable flag: an imported document is READ-ONLY
  // until then (CodeMirror renders contenteditable=false and silently swallows keystrokes).
  async function openDoc(
    page: Page,
    content: string,
    opts: { editable?: boolean } = {},
  ): Promise<void> {
    const file = join(scratch, `doc-${Date.now()}.md`)
    writeFileSync(file, content, 'utf-8')
    const id = await page.evaluate(
      (f) => window.api.documents.import(f).then((d: any) => d.id),
      file,
    )
    expect(id).toBeTruthy()
    await page.evaluate(
      (args) => {
        const w = window as any
        w.__uiStore.getState().setActiveDocumentId(args.id)
        if (args.editable) w.__uiStore.getState().setEditable(true)
        w.__queryClient.invalidateQueries({ queryKey: ['documents'] })
      },
      { id, editable: !!opts.editable },
    )
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.locator('.markdown-preview')).toBeVisible()
  }

  test('top-level blocks carry a data-line source mapping (R6)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Heading\n\nA paragraph.\n')

    await expect(page.locator('.markdown-preview h1').first()).toHaveAttribute('data-line', /\d+/)
    await expect(page.locator('.markdown-preview p').first()).toHaveAttribute('data-line', /\d+/)
  })

  test('the <article> holds content directly — no wrapper div (P8)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Heading\n\nA paragraph.\n')

    // A direct-child (`>`) selector only matches when the block is NOT nested inside a wrapper
    // div — the exact extra layer the removed SafeHtml component used to introduce.
    await expect(page.locator('article.markdown-preview > h1').first()).toBeVisible()
    await expect(page.locator('article.markdown-preview > p').first()).toBeVisible()
  })

  // R12① (plan-03 §4.2): the preview article is the document semantic root — role="document"
  // always, and a leading frontmatter `lang:` flows to the article's lang attribute.
  test('the preview <article> exposes role="document" with no lang by default (R12①)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '# Heading\n\nA paragraph.\n')

    const article = page.locator('article.markdown-preview')
    await expect(article).toHaveAttribute('role', 'document')
    await expect(article).not.toHaveAttribute('lang')
  })

  test('a frontmatter lang is mirrored onto the preview article (R12①)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, '---\nlang: zh-CN\n---\n\n# Heading\n\nA paragraph.\n')

    await expect(page.locator('article.markdown-preview')).toHaveAttribute('lang', 'zh-CN')
  })

  // ── Stage-1 follow-ups (N3 / N4 / N8): incremental-patch REALLY reuses nodes ──

  test('a relative image keeps its appdoc:// src through the sanitize gate', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // A real 1x1 PNG next to the document, so appdoc:// resolves and the image does
    // NOT fall into the error-placeholder path (which would remove the <img> entirely
    // and hide a stripped src).
    writeFileSync(join(scratch, 'pic.png'), Buffer.from(PNG_1X1, 'base64'))
    await openDoc(page, '# Heading\n\n![pic](pic.png)\n')

    const img = page.locator('article.markdown-preview img')
    await expect(img).toHaveCount(1)
    // The pipeline rewrites relative -> appdoc://<docId>/…; the sanitize gate must
    // KEEP that custom scheme, otherwise every local image silently loses its src.
    await expect(img).toHaveAttribute('src', /^appdoc:\/\//)
  })

  test('re-parsing reuses unchanged blocks and does not reload images (R4 / N3)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    writeFileSync(join(scratch, 'pic.png'), Buffer.from(PNG_1X1, 'base64'))
    await openDoc(page, '# Heading\n\nA paragraph.\n\n![pic](pic.png)\n', { editable: true })
    await expect(page.locator('.cm-content')).toContainText('Heading')

    await expect(page.locator('article.markdown-preview img')).toHaveCount(1)
    // Stash the live nodes: identity (===) is the only honest proof that morphdom
    // patched in place instead of destroying and rebuilding the subtree.
    await page.evaluate(() => {
      const w = window as any
      w.__probeP = document.querySelector('article.markdown-preview p')
      w.__probeImg = document.querySelector('article.markdown-preview img')
    })

    await typeAtEnd(page, '\n\nPROBE')
    // Wait for the NEW block to land (proves a re-parse + patch actually happened)…
    await expect(page.locator('article.markdown-preview p', { hasText: 'PROBE' })).toHaveCount(1)

    // …then assert the UNCHANGED blocks are the very same node instances.
    const reused = await page.evaluate(() => {
      const w = window as any
      return {
        p: document.querySelector('article.markdown-preview p') === w.__probeP,
        img: document.querySelector('article.markdown-preview img') === w.__probeImg,
      }
    })
    expect(reused.p).toBe(true)
    expect(reused.img).toBe(true)
  })

  test('a mermaid diagram is byte-stable across re-parses (N4)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await openDoc(page, ['```mermaid', 'graph TD', '  A[Start] --> B[End]', '```', ''].join('\n'), {
      editable: true,
    })
    await expect(page.locator('.cm-content')).toContainText('graph TD')

    const svg = page.locator('[data-mermaid-slot="0"] svg')
    // Preview mermaid bakes lazily via IntersectionObserver; scroll into view so it bakes even
    // when it starts below the fold on a short window.
    await svg.scrollIntoViewIfNeeded()
    await expect(svg).toBeVisible({ timeout: 30_000 })
    const before = await svg.evaluate((el) => el.outerHTML)

    await typeAtEnd(page, '\n\nPROBE')
    await expect(page.locator('article.markdown-preview p', { hasText: 'PROBE' })).toHaveCount(1)
    await expect(svg).toBeVisible({ timeout: 30_000 })

    const after = await svg.evaluate((el) => el.outerHTML)
    // The diagram source did not change, so the baked SVG must be IDENTICAL. If it is
    // not (e.g. a random render id leaks into the markup), morphdom can never take its
    // "subtree unchanged -> skip" fast path and the diagram is rebuilt on every keystroke.
    expect(after).toBe(before)
  })

  // The committed e2e fixture (e2e/fixtures/preview-render-pipeline/diagrams.md — a copy of
  // examples/demo.en.md) ships 4 diagrams. Re-baking them makes mermaid append its temporary
  // container
  // straight to document.body (mermaid.core.mjs renderDiagram: `root = select("body")`).
  // If the ROOT can scroll, that overflow flips a top-level scrollbar on for a frame,
  // #root loses the scrollbar's width and the WHOLE shell (both panes' scrollbars, the
  // toolbar) jolts sideways once per keystroke — the whole-app flicker symptom.
  test('the shell does not shift width while diagrams are re-baked', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // Self-contained: read the doc from e2e's own test-data dir (no dependency on examples/),
    // then open it through the same import + UI-store path as every other test in this suite.
    const content = readFileSync(DIAGRAM_FIXTURE, 'utf-8')
    await openDoc(page, content, { editable: true })
    // D-E① renders diagrams LAZILY: a placeholder only bakes once it intersects the preview
    // viewport (IntersectionObserver with rootMargin 200px — MarkdownPreview.tsx). Slot 3 is the
    // LAST of the four diagrams and sits below the fold when the document opens, so it must be
    // scrolled into view before it can bake at all. (Only slot 0/1 are on-screen at open, which is
    // why the mermaid suites above, asserting those slots, never needed this step.)
    await page.locator('[data-mermaid-slot="3"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="3"] svg')).toBeVisible({ timeout: 60_000 })

    // Sample the root width every frame: ANY change is the visible sideways jolt.
    await page.evaluate(() => {
      const w = window as any
      const de = document.documentElement
      const p = (w.__p = {
        rootWidths: new Set<number>(),
        overflowFrames: 0,
        raf: 0,
      })
      const tick = () => {
        p.rootWidths.add(document.querySelector('#root')!.getBoundingClientRect().width)
        if (de.scrollHeight > de.clientHeight + 1 || de.scrollWidth > de.clientWidth + 1) {
          p.overflowFrames++
        }
        p.raf = requestAnimationFrame(tick)
      }
      tick()
    })

    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\n\njolt probe\n')
    await expect(page.locator('article.markdown-preview p', { hasText: 'jolt probe' })).toHaveCount(
      1,
    )
    await expect(page.locator('[data-mermaid-slot="3"] svg')).toBeVisible({ timeout: 60_000 })

    const probe = await page.evaluate(() => {
      const p = (window as any).__p
      cancelAnimationFrame(p.raf)
      return { rootWidths: Array.from(p.rootWidths) as number[], overflowFrames: p.overflowFrames }
    })
    // One single width across every sampled frame, and never a root-level overflow.
    expect(probe.rootWidths).toHaveLength(1)
    expect(probe.overflowFrames).toBe(0)
  })

  test('two identical diagrams still get distinct, stable ids (N4)', async () => {
    const { page } = handle
    await waitForAppReady(page)
    // Same source twice => same hash, so uniqueness MUST come from the slot index;
    // otherwise the document ends up with duplicate DOM ids.
    const fence = ['```mermaid', 'graph TD', '  A[Start] --> B[End]', '```'].join('\n')
    await openDoc(page, `${fence}\n\n${fence}\n`)

    // Preview mermaid bakes lazily via IntersectionObserver; scroll slot 0 into view first so it
    // bakes even on a short window (slot 1 sits right below and rides along into view).
    await page.locator('[data-mermaid-slot="0"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="0"] svg')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-mermaid-slot="1"] svg')).toBeVisible({ timeout: 30_000 })
    const ids = await page.evaluate(() =>
      [0, 1].map((i) => document.querySelector(`[data-mermaid-slot="${i}"] svg`)?.id ?? ''),
    )
    expect(ids[0]).not.toBe('')
    expect(ids[1]).not.toBe('')
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/^mermaid-[a-z0-9]+-0$/)
    expect(ids[1]).toMatch(/^mermaid-[a-z0-9]+-1$/)
  })

  // Window-pinned (small-window) guard for the lazy mermaid render: pinned to the minimum allowed
  // size (minWidth 800 / minHeight 600) so the IntersectionObserver path is exercised under a short,
  // narrow split pane — the exact condition that made the diagrams.md copy test flake on CI. A
  // diagram that opens below the fold (slot 3, the last of four) must still bake once scrolled.
  test('small window: off-screen mermaid diagrams still bake when scrolled into view', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await page.setViewportSize({ width: 800, height: 600 })
    const content = readFileSync(DIAGRAM_FIXTURE, 'utf-8')
    await openDoc(page, content, { editable: true })
    // Slot 0 is on-screen at open; slot 3 starts below the fold.
    await page.locator('[data-mermaid-slot="0"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="0"] svg')).toBeVisible({ timeout: 60_000 })
    await page.locator('[data-mermaid-slot="3"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-mermaid-slot="3"] svg')).toBeVisible({ timeout: 60_000 })
  })
})

// A 1x1 transparent PNG, so a relative image reference resolves for real.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** Append `text` at the very end of the editor document (deterministic cursor position). */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
  // Sanity: the keystrokes actually landed in the document (a read-only editor would
  // swallow them, which would make every "preview updated" assertion below vacuous).
  await expect(page.locator('.cm-content')).toContainText(text.trim())
}
