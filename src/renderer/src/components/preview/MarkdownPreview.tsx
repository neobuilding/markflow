import React, { useState, useRef, useEffect } from 'react'
import { useUIStore } from '../../store/ui'
import { parseMarkdown } from '../../lib/parseClient'
import type { RenderResult } from '../../lib/markdownPipeline'
import { scrollSync } from '../../lib/scrollSync'
import { sanitizeHtml, type SanitizedHtml } from '../../lib/sanitize'
import { patchPreviewContent, DATA_BAKED } from '../../lib/previewRender'
import { setExportHtml, setExportContent } from '../../lib/exportStore'
import { useT } from '../../i18n'
import { PreviewContextMenu } from './PreviewContextMenu'
import type { Document } from '../../types'
// Mermaid is heavy (~2.5 MB) and only needed when a document actually contains a
// diagram, so it is dynamically imported on first use instead of being bundled into
// the initial preview chunk. The module is cached after the first load.
interface MermaidApi {
  initialize: (config: unknown) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}
let mermaidReady: Promise<MermaidApi> | null = null

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = import('mermaid')
      .then((m) => {
        const mod = m.default as unknown as MermaidApi
        mod.initialize({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false })
        return mod
      })
      // If the dynamic import rejects (corrupt/missing chunk), clear the cached
      // promise so the NEXT render retries instead of permanently rejecting for
      // the whole session.
      /* v8 ignore start -- defensive: the import-failure path isn't exercised under jsdom (mermaid is bundled) */
      .catch((err) => {
        mermaidReady = null
        throw err
      })
    /* v8 ignore stop */
  }
  return mermaidReady
}

// Encode a mermaid source so it survives BOTH the HTML parser and DOMPurify.
//
// HTML-escaping is NOT enough: the parser decodes entities BEFORE DOMPurify inspects
// the attribute, so `&gt;` is already a literal `>` by then — and DOMPurify drops an
// attribute whose value contains `-->` (locked in by sanitize.test.ts). Mermaid
// flowcharts are full of `A-->B`, so escaping silently removed the attribute and left
// "Copy diagram source" permanently greyed out in the real app. URI-encoding keeps the
// decoded value free of `<`, `>`, `&` and `"`, so the attribute always survives.
// The reader decodes it again (see PreviewContextMenu.tsx).

// Module-level serial queue: mermaid has internal global state (shared id / temp DOM),
// so concurrent renders would corrupt diagrams / throw. All renders are queued.
let mermaidChain: Promise<unknown> = Promise.resolve()
function renderMermaidSvg(id: string, code: string): Promise<{ svg: string }> {
  const task = mermaidChain.then(async () => {
    const mermaid = await getMermaid()
    return mermaid.render(id, code.trim())
  })
  /* v8 ignore next -- defensive: the mermaid render error path isn't exercised under jsdom, but it keeps the serial queue alive */
  mermaidChain = task.catch(() => undefined) // Keep the chain alive on failure so later renders aren't blocked.
  return task as Promise<{ svg: string }>
}

interface MarkdownPreviewProps {
  content: string
  doc?: Document | null
}

export function MarkdownPreview({ content, doc }: MarkdownPreviewProps): React.ReactElement {
  const previewRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderToken = useRef(0)
  const lastDocIdRef = useRef<string | null | undefined>(undefined)
  const [sanitizedHtml, setSanitizedHtml] = useState<SanitizedHtml>(sanitizeHtml(''))
  const [loading, setLoading] = useState(true)
  // docId comes from the global store and is passed to the Worker via comlink for appdoc: image rewriting.
  const docId = useUIStore((s) => s.activeDocumentId)
  // Tracks whether the preview has rendered at least once, so the parse effect can decide whether to
  // parse immediately (first paint) without reading `sanitizedHtml` reactively (which would make it a
  // dependency and cause a re-parse loop). This ref gates the "parse immediately on first paint"
  // path instead of checking `sanitizedHtml === ''` reactively.
  const hasContentRef = useRef(false)
  // The content seen on the previous render. Used to detect "recovering from an
  // empty pane" see `isRecovering` below
  const prevContentRef = useRef('')
  const { t } = useT()
  // Mirror `t` in a ref so effects can read the latest translator without making it a
  // dependency (which would re-run the parse effect on every language switch). The
  // assignment happens in an effect (not during render) to satisfy react-hooks/refs.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  // Parsing: sent to the Worker via comlink, with automatic fallback to the main thread on failure.
  // Parse immediately on first paint / document switch (no debounce); only debounce 150ms for
  // consecutive keystrokes within the same document, so the "open / switch document" critical path
  // never waits on the debounce (otherwise the preview would sit empty first).
  useEffect(() => {
    const token = ++renderToken.current
    const isDocSwitch = docId !== lastDocIdRef.current
    lastDocIdRef.current = docId
    // Recovering from an empty pane: the document switch empties the panes first
    // (docId already changed on that commit) and fills in the real content on the
    // NEXT commit, where isDocSwitch is already false. Without this the fill would
    // take the 150ms keystroke-debounce path and the preview would sit blank for
    // 150ms after every switch to an uncached document.
    const isRecovering = prevContentRef.current === '' && content !== ''
    prevContentRef.current = content
    const immediate = isDocSwitch || isRecovering || !hasContentRef.current
    let cancelled = false

    // On document switch: clear old content immediately and show Loading to avoid stale content.
    if (isDocSwitch) {
      setSanitizedHtml(sanitizeHtml(''))
      setLoading(true)
    }

    const run = () => {
      parseMarkdown(content, docId)
        .then(async (res: RenderResult) => {
          if (cancelled || token !== renderToken.current) return
          // Bake mermaid before injection: replace placeholder <div data-mermaid-slot="{i}"> with
          // the raw SVG, producing the full HTML string containing mermaid SVGs. Sanitization is
          // performed ONCE below (single point, see §5.2) and the result is shared by the preview
          // DOM patch and the export cache.
          let html = res.html
          if (res.mermaid.length > 0) {
            await getMermaid()
            const svgs: string[] = []
            // Slot → raw mermaid source, so the rendered wrapper can carry it as
            // `data-mermaid-source` for the "Copy diagram source" menu ()
            // A slot whose render fails is removed here so the failure placeholder is NOT
            // given a source attribute (: failed diagrams fall back to the
            // generic menu, which has no copy-source item).
            const sources = new Map(res.mermaid.map((m) => [m.slot, m.code]))
            for (const m of res.mermaid) {
              // Two ids, on purpose:
              //  - `renderId` is RANDOM and only ever handed to mermaid: the preview DOM
              //    already contains the previously baked <svg id="…">, and mermaid looks
              //    nodes up by id, so a reusable id could make it latch onto the stale
              //    diagram. Random keeps mermaid's own temp DOM collision-free.
              //  - `stableId` is what we actually INJECT: mermaid bakes the id into the
              //    svg element id, every <style> selector, the node ids and the <filter>
              //    ids, so a random id makes the SVG differ on every keystroke — morphdom
              //    then never hits its "subtree unchanged → skip" fast path and the whole
              //    diagram is torn down and rebuilt while typing. Normalising the baked
              //    markup to a deterministic id (hash + slot, unique within a document)
              //    makes an unchanged diagram byte-identical across re-parses.
              const renderId = `mermaid-${m.hash}-${Math.random().toString(36).slice(2)}`
              const stableId = `mermaid-${m.hash}-${m.slot}`
              try {
                const out = await renderMermaidSvg(renderId, m.code)
                svgs[m.slot] = out.svg.split(renderId).join(stableId)
              } catch {
                sources.delete(m.slot)
                svgs[m.slot] =
                  `<div class="mermaid-skeleton">⚠ ${tRef.current('preview.mermaidFailed')}</div>`
              }
            }
            // Replace each placeholder with a wrapper that KEEPS the container (the SVG is
            // injected inside it), so the `data-mermaid-source` attribute survives. The
            // original plan wrote the source on the placeholder div, but the old replace
            // discarded the whole div keeping the wrapper fixes that.
            // The match must tolerate EXTRA attributes, not assume the exact
            // `<div data-mermaid-slot="N"></div>` shape: the pipeline also tags the
            // placeholder with `data-line` (R6), and any such extras are preserved on the
            // baked wrapper so its source mapping survives the swap.
            html = html.replace(
              /<div data-mermaid-slot="(\d+)"([^>]*)><\/div>/g,
              (_m, i, extra: string) => {
                const slot = Number(i)
                // `svgs[slot]` is always populated by the render loop above (every mermaid
                // slot is rendered into `svgs`), so the fallback is purely defensive.
                /* v8 ignore next */
                const svg = svgs[slot] ?? ''
                const src = sources.get(slot)
                const attr = src ? ` data-mermaid-source="${encodeURIComponent(src)}"` : ''
                return `<div data-mermaid-slot="${slot}"${extra}${attr}>${svg}</div>`
              },
            )
          }
          /* v8 ignore next -- defensive: guards a stale/aborted render; the cancelled/token-mismatch returns aren't exercised under jsdom's synchronous render */
          if (cancelled || token !== renderToken.current) return
          // Single sanitization gate (D-C / R5): the only place un-sanitized HTML is turned into
          // `SanitizedHtml`. The branded return type then forces every downstream consumer to use
          // this exact value — it is reused for BOTH the preview DOM patch and the export cache,
          // so preview and export are guaranteed to be the same source (R7).
          const clean = sanitizeHtml(html)
          setExportHtml(clean)
          // Stash the raw markdown (frontmatter intact) so export/print can resolve <html lang> on demand.
          setExportContent(content)
          setSanitizedHtml(clean)
          hasContentRef.current = true
          setLoading(false)
          // Note: no scrollSync.realign() — images are no longer reloaded on every keystroke
          // (the DOM is incrementally patched, not rebuilt), so the preview height is stable and
          // the ratio-based sync needs no height-jump compensation (Plan 01 §5.4).
        })
        .catch((err) => {
          /* v8 ignore next -- defensive: same stale/aborted-render guard as the success path; not exercised under jsdom */
          if (cancelled || token !== renderToken.current) return
          console.error('[MarkFlow] Parse failed:', err)
          setLoading(false)
        })
    }

    // Document switch uses setTimeout(0): merge the transient double render where "docId changes
    // first, content changes later via useLocalDocument's effect" into a single (docId, content)
    // send to the Worker. For consecutive keystrokes in the same document: debounce 150ms.
    const timer = setTimeout(run, immediate ? 0 : 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [content, docId])

  // Container-level error delegation: downgrade failed images to a placeholder (covers all <img>
  // inside the injected HTML). Attached ONCE to the <article> container: because the preview is
  // now patched incrementally (not rebuilt) the <article> node itself is stable across renders,
  // so a single capture-phase listener survives every content update. (The old `load`-time
  // realign that compensated for image height jumps is gone — images are no longer reloaded on
  // each keystroke, so the height is stable; see Plan 01 §5.4.)
  useEffect(() => {
    const container = previewRef.current
    // The ref is attached to the <article> rendered below, so it is always populated once
    // this effect runs; the guard only narrows its nullable type for TypeScript.
    /* v8 ignore next -- defensive: the ref is attached to the rendered <article>, so it is always populated when this effect runs */
    if (!container) return
    const onErr = (e: Event) => {
      const target = e.target as HTMLElement | null
      /* v8 ignore next -- defensive image-error fallback: image 'error' events don't fire under jsdom, so this early-return branch is never exercised */
      if (!target || target.tagName !== 'IMG') return
      const img = target as HTMLImageElement
      /* v8 ignore next -- defensive: the already-applied guard is only hit on a second error event, which jsdom doesn't emit */
      if (img.dataset.fallbackApplied) return
      img.dataset.fallbackApplied = '1'
      const placeholder = document.createElement('span')
      placeholder.className = 'img-error-placeholder'
      placeholder.setAttribute(DATA_BAKED, '1')
      const alt = img.getAttribute('alt') ?? ''
      placeholder.textContent = alt
        ? `⚠ ${tRef.current('preview.imageFailedAlt', { alt })}`
        : `⚠ ${tRef.current('preview.imageFailed')}`
      placeholder.style.cssText =
        'display:inline-block;padding:4px 8px;margin:4px 0;border:1px dashed var(--color-border);' +
        'border-radius:6px;color:var(--color-text-tertiary);font-size:12px;background:var(--color-surface-overlay);'
      img.replaceWith(placeholder)
    }
    container.addEventListener('error', onErr, true)
    return () => {
      container.removeEventListener('error', onErr, true)
    }
  }, [])

  // Incremental DOM patch (R4): morph the <article> into the latest sanitized HTML
  // whenever it changes, instead of rebuilding the whole subtree. `sanitizedHtml` is the
  // single sanitized source produced by the parse effect above; the branded type guarantees
  // it has already passed through `sanitizeHtml` (no second sanitization, no wrapper).
  useEffect(() => {
    const el = previewRef.current
    // The ref is attached to the <article> rendered below, so it is always populated once
    // this effect runs; the guard only narrows its nullable type for TypeScript.
    /* v8 ignore next -- defensive: the ref is attached to the rendered <article>, so it is always populated when this effect runs */
    if (!el) return
    patchPreviewContent(el, sanitizedHtml)
  }, [sanitizedHtml])

  // Register with the scroll-sync controller (preview side).
  useEffect(() => {
    const el = scrollRef.current
    // The ref is attached to the scroll container rendered below, so it is always populated
    // once this effect runs; the guard only narrows its nullable type for TypeScript.
    /* v8 ignore next -- defensive: the ref is attached to the scroll container, so it is always populated when this effect runs */
    if (!el) return
    scrollSync.register('preview', el)
    return () => scrollSync.unregister('preview')
  }, [])

  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-auto w-full"
      style={{ background: 'var(--color-surface)' }}
    >
      <PreviewContextMenu doc={doc} previewRef={previewRef}>
        {/* The <article> is the patch root: MarkdownPreview writes its children via
            patchPreviewContent (morphdom), so it must NOT have React-managed children here —
            only the loading overlay (below) is React-controlled, and it lives OUTSIDE the
            article so the two never fight over the same DOM subtree (P8: no extra wrapper). */}
        <article
          ref={previewRef}
          tabIndex={0}
          className="markdown-preview prose dark:prose-invert max-w-none px-6 py-6 w-full"
        />
      </PreviewContextMenu>
      {loading && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[var(--color-text-tertiary)] text-sm">
          {t('editor.loading')}
        </div>
      )}
    </div>
  )
}
