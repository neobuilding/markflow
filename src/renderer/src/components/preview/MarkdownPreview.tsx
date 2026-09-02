import React, { useState, useRef, useEffect } from 'react'
import { useUIStore } from '../../store/ui'
import { parseMarkdown } from '../../lib/parseClient'
import type { RenderResult } from '../../lib/markdownPipeline'
import { SafeHtml } from '../SafeHtml'
import { scrollSync } from '../../lib/scrollSync'
import { debounce } from '../../lib/utils'
import { sanitizeHtml } from '../../lib/sanitize'
import { setExportHtml, setExportContent } from '../../lib/exportStore'
import { useT } from '../../i18n'
import mermaid from 'mermaid'

let mermaidInitialized = false
function ensureMermaid(): void {
  if (!mermaidInitialized) {
    mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false })
    mermaidInitialized = true
  }
}

// Module-level serial queue: mermaid has internal global state (shared id / temp DOM),
// so concurrent renders would corrupt diagrams / throw. All renders are queued.
let mermaidChain: Promise<unknown> = Promise.resolve()
function renderMermaidSvg(id: string, code: string): Promise<{ svg: string }> {
  const task = mermaidChain.then(() => mermaid.render(id, code.trim()))
  /* v8 ignore next -- defensive: the mermaid render error path isn't exercised under jsdom, but it keeps the serial queue alive */
  mermaidChain = task.catch(() => undefined) // Keep the chain alive on failure so later renders aren't blocked.
  return task as Promise<{ svg: string }>
}

interface MarkdownPreviewProps {
  content: string
}

export function MarkdownPreview({ content }: MarkdownPreviewProps): React.ReactElement {
  const previewRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderToken = useRef(0)
  const lastDocIdRef = useRef<string | null | undefined>(undefined)
  const [renderedHtml, setRenderedHtml] = useState('')
  const [loading, setLoading] = useState(true)
  // docId comes from the global store and is passed to the Worker via comlink for appdoc: image rewriting.
  const docId = useUIStore((s) => s.activeDocumentId)
  // Tracks whether the preview has rendered at least once, so the parse effect can decide whether to
  // parse immediately (first paint) without reading `renderedHtml` reactively (which would make it a
  // dependency and cause a re-parse loop). This ref gates the "parse immediately on first paint"
  // path instead of checking `renderedHtml === ''` reactively.
  const hasContentRef = useRef(false)
  // The content seen on the previous render. Used to detect "recovering from an
  // empty pane" — see `isRecovering` below.
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
      setRenderedHtml('')
      setLoading(true)
    }

    const run = () => {
      parseMarkdown(content, docId)
        .then(async (res: RenderResult) => {
          if (cancelled || token !== renderToken.current) return
          // Bake mermaid before injection: replace placeholder <div data-mermaid-slot="{i}"> with
          // the raw SVG, producing the full HTML string containing mermaid SVGs; sanitization is
          // done once later by SafeHtml.
          let html = res.html
          if (res.mermaid.length > 0) {
            ensureMermaid()
            const svgs: string[] = []
            for (const m of res.mermaid) {
              const id = `mermaid-${m.hash}-${Math.random().toString(36).slice(2)}`
              try {
                const out = await renderMermaidSvg(id, m.code)
                svgs[m.slot] = out.svg
              } catch {
                svgs[m.slot] =
                  `<div class="mermaid-skeleton">⚠ ${tRef.current('preview.mermaidFailed')}</div>`
              }
            }
            html = html.replace(
              /<div data-mermaid-slot="(\d+)"><\/div>/g,
              /* v8 ignore next -- defensive: a slot referencing a missing SVG is malformed input; the fallback keeps the layout intact */
              (_m, i) => svgs[Number(i)] ?? '',
            )
          }
          /* v8 ignore next -- defensive: guards a stale/aborted render; the cancelled/token-mismatch returns aren't exercised under jsdom's synchronous render */
          if (cancelled || token !== renderToken.current) return
          // Stash the "sanitized" preview HTML as the single source of truth for export (R7 single source).
          // SafeHtml sanitizes again on render (idempotent), keeping the single-point semantics.
          setExportHtml(sanitizeHtml(html))
          // Stash the raw markdown (frontmatter intact) so export/print can resolve <html lang> on demand.
          setExportContent(content)
          setRenderedHtml(html)
          hasContentRef.current = true
          setLoading(false)
          // Fallback: after parsing completes (large images may be ready now or soon), realign once
          // to fix the half-screen offset caused by image height jumps (Final Design §3.1).
          requestAnimationFrame(() => scrollSync.realign())
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
  // inside the injected HTML). Also attach a load delegate (capture phase, needed to catch <img>
  // load) so that after an image is ready and the preview height changes, a debounced realign
  // keeps scroll in sync, fixing the half-screen offset from height jumps (W5-D).
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
      const alt = img.getAttribute('alt') ?? ''
      placeholder.textContent = alt
        ? `⚠ ${tRef.current('preview.imageFailedAlt', { alt })}`
        : `⚠ ${tRef.current('preview.imageFailed')}`
      placeholder.style.cssText =
        'display:inline-block;padding:4px 8px;margin:4px 0;border:1px dashed var(--color-border);' +
        'border-radius:6px;color:var(--color-text-tertiary);font-size:12px;background:var(--color-surface-overlay);'
      img.replaceWith(placeholder)
    }
    const onLoad = debounce(() => scrollSync.realign(), 150)
    container.addEventListener('error', onErr, true)
    container.addEventListener('load', onLoad, true)
    return () => {
      container.removeEventListener('error', onErr, true)
      container.removeEventListener('load', onLoad, true)
    }
  }, [renderedHtml])

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
      <article
        ref={previewRef}
        className="markdown-preview prose dark:prose-invert max-w-none px-6 py-6 w-full"
      >
        {loading && renderedHtml === '' ? (
          <div className="text-[var(--color-text-tertiary)] text-sm">{t('editor.loading')}</div>
        ) : (
          <SafeHtml html={renderedHtml} />
        )}
      </article>
    </div>
  )
}
