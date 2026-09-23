import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useUIStore } from '../../store/ui'
import { parseMarkdown } from '../../lib/parseClient'
import type { RenderResult, MermaidSlot } from '../../lib/markdownPipeline'
import { scrollSync } from '../../lib/scrollSync'
import { sanitizeHtml, type SanitizedHtml } from '../../lib/sanitize'
import { patchPreviewContent, DATA_BAKED } from '../../lib/previewRender'
import { setExportHtml, setExportContent, setExportMermaidSlots } from '../../lib/exportStore'
import { useT } from '../../i18n'
import {
  consumePendingCopy,
  buildPreviewCopyPayload,
  warmInlinedImages,
  deferColdCopy,
} from '../../lib/previewCopy'
import { safeEnhanceForPaste } from '../../lib/copyFidelity'
import { extractFrontmatterLang } from '../../lib/lang'
import type { Document, ThemeMode } from '../../types'
// D-B (plan-03 §4.1): the single source of truth for markdown styling is github-markdown-css
// (the same sheet the exporter uses), injected as a string so we can toggle light/dark by
// disabling one of the two variant stylesheets — no `.prose` / `.dark` prefix overlay.
import lightCss from 'github-markdown-css/github-markdown.css?inline'
import darkCss from 'github-markdown-css/github-markdown-dark.css?inline'
import { PreviewContextMenu } from './PreviewContextMenu'
// D-E① (plan-03 §4.3): mermaid lives in lib/mermaidBake.ts so the lazy preview and the
// COMPLETE export/print/copy bake share one hash cache (ADR 0019) — export must never
// depend on which diagrams happen to be on screen.
import { renderMermaidSlot, mermaidSvgCache, fillMermaidSlot } from '../../lib/mermaidBake'
import { scheduleExportBake } from '../../lib/exportBake'

// R9 (plan-03 §4.4): resolve intrinsic dimensions of local `appdoc://` images before
// sanitize/patch so the browser reserves space and the first paint doesn't jump (CLS).
async function applyImageDimensions(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const imgs = Array.from(doc.querySelectorAll('img[src^="appdoc://"]:not([width]):not([height])'))
  // Braces (not a single-line if) on purpose: v8 counts an implicit empty "else" range for a
  // braceless `if`, which shows up as an uncovered block even though this line runs on every
  // parse of a document without local images.
  if (imgs.length === 0) {
    return html
  }
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src')
      // Unreachable: the `img[src^="appdoc://"]` selector already guarantees a non-empty src.
      /* v8 ignore next */
      if (!src) return
      try {
        const size = await window.api.documents.imageSize(src)
        if (size) {
          img.setAttribute('width', String(size.width))
          img.setAttribute('height', String(size.height))
        }
      } catch {
        /* leave without dimensions */
      }
    }),
  )
  return doc.body.innerHTML
}

// D-B (plan-03 §4.1): inject the single github-markdown-css source of truth once, and toggle
// light/dark via the `disabled` flag. The two variant files are independent full stylesheets
// (not a `.dark` prefix overlay), so we never rely on a `.dark` class — plan-03 §4.1.
let mdBodyStylesInjected = false
function injectMarkdownBodyStyles(): void {
  if (mdBodyStylesInjected) return
  const head = document.head
  const light = document.createElement('style')
  light.id = 'md-body-light'
  light.textContent = lightCss
  const dark = document.createElement('style')
  dark.id = 'md-body-dark'
  dark.textContent = darkCss
  head.appendChild(light)
  head.appendChild(dark)
  mdBodyStylesInjected = true
}
function applyMarkdownBodyTheme(theme: ThemeMode): boolean {
  let isDark: boolean
  if (theme === 'light') isDark = false
  else if (theme === 'dark') isDark = true
  else
    isDark =
      typeof window !== 'undefined' && !!window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false
  const light = document.getElementById('md-body-light') as HTMLStyleElement | null
  const dark = document.getElementById('md-body-dark') as HTMLStyleElement | null
  if (light) light.disabled = isDark
  if (dark) dark.disabled = !isDark
  return isDark
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
  const docId = useUIStore((s) => s.activeDocumentId)
  const theme = useUIStore((s) => s.theme)
  const hasContentRef = useRef(false)
  const prevContentRef = useRef('')
  const { t } = useT()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const mermaidSlotsRef = useRef<MermaidSlot[]>([])
  const mermaidObserverRef = useRef<IntersectionObserver | null>(null)
  const lang = useMemo(() => extractFrontmatterLang(content), [content])

  useEffect(() => {
    const token = ++renderToken.current
    const isDocSwitch = docId !== lastDocIdRef.current
    lastDocIdRef.current = docId
    const isRecovering = prevContentRef.current === '' && content !== ''
    prevContentRef.current = content
    const immediate = isDocSwitch || isRecovering || !hasContentRef.current
    let cancelled = false

    if (isDocSwitch) {
      setSanitizedHtml(sanitizeHtml(''))
      setLoading(true)
    }

    const run = () => {
      parseMarkdown(content, docId)
        .then(async (res: RenderResult) => {
          if (cancelled || token !== renderToken.current) return
          // D-E① (plan-03 §4.3): do NOT bake mermaid into the HTML string. Keep the empty
          // `<div data-mermaid-slot>` placeholders and render them lazily in the DOM after
          // the incremental patch (IntersectionObserver + hash cache). The old "Copy diagram
          // source" menu item was removed in plan-02 D3, so no `data-mermaid-source` attribute
          // is needed — plan-03 §4.3's stale reference to it is dropped per plan-02 D9.
          mermaidSlotsRef.current = res.mermaid
          let html = res.html
          // R9 (plan-03 §4.4): resolve intrinsic dimensions of local images before
          // sanitize/patch so the first paint reserves space and doesn't jump (CLS).
          try {
            html = await applyImageDimensions(html)
            /* v8 ignore next 2 */
          } catch {
            /* dimension resolution failures are non-fatal: images still load, just without reserved space */
          }
          if (cancelled || token !== renderToken.current) return
          // Single sanitization gate (plan-01 §5.2): the cleaned HTML is shared by the preview
          // DOM patch and the export cache.
          const clean = sanitizeHtml(html)
          // ADR 0019: stash the diagram sources next to the HTML. The preview keeps empty
          // placeholders, so the complete bake (export / print / copy) needs the SOURCE to
          // render them itself — it cannot recover them from the string.
          setExportMermaidSlots(res.mermaid)
          setExportHtml(clean)
          setExportContent(content)
          setSanitizedHtml(clean)
          hasContentRef.current = true
          setLoading(false)
          // ADR 0019: keep the preview lazy, but make the export cache a COMPLETE render so
          // export / print / copy never depend on what is currently on screen. Deferred so the
          // bake does not compete with the keystroke that triggered this parse; export / print
          // await it explicitly, and copy reads a cache that is complete by then.
          scheduleExportBake()
          // Note: no scrollSync.realign() — images are no longer reloaded on every keystroke
          // (the DOM is incrementally patched, not rebuilt), so the preview height is stable and
          // the ratio-based sync needs no height-jump compensation (Plan 01 §5.4).
        })
        .catch((err) => {
          if (cancelled || token !== renderToken.current) return
          console.error('[MarkFlow] Parse failed:', err)
          setLoading(false)
        })
    }

    const timer = setTimeout(run, immediate ? 0 : 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [content, docId])

  // Delegate <img> load errors to a visible placeholder (icons / images fail in preview
  // when their absolute path can't be resolved). Wrapped images already carry data-baked.
  useEffect(() => {
    const container = previewRef.current
    // Unreachable: this effect runs after mount, when the article ref is always attached.
    /* v8 ignore next */
    if (!container) return
    const onErr = (e: Event) => {
      const target = e.target as HTMLElement | null
      // `!target` is unreachable (a dispatched event always has a target); the tagName half is
      // real and covered by "ignores an error event that does not target an image".
      /* v8 ignore next */
      if (!target || target.tagName !== 'IMG') return
      const img = target as HTMLImageElement
      // Unreachable today: the first error REPLACES the <img>, so the node cannot error twice
      // while still attached. Kept as a guard for the day the patcher reuses the node.
      /* v8 ignore next */
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

  useEffect(() => {
    const el = previewRef.current
    // Unreachable: same as the error-handler effect — the ref is attached when this runs.
    /* v8 ignore next */
    if (!el) return
    patchPreviewContent(el, sanitizedHtml)
    // Plan 04: pre-inline images (§4.8) so the synchronous copy path can paste base64 images
    // without awaiting. Fire-and-forget. (Math needs no pre-pass: it rides its MathML, §4.8.)
    void warmInlinedImages(el)
    // D-E①: after the incremental patch, fill any cache-hit mermaid immediately (so a
    // re-parse never wipes an already-rendered diagram) and lazily render the rest.
    el.querySelectorAll('[data-mermaid-slot]').forEach((node) => {
      const slotEl = node as HTMLElement
      const slot = Number(slotEl.getAttribute('data-mermaid-slot'))
      const info = mermaidSlotsRef.current.find((m) => m.slot === slot)
      if (!info) return
      const cached = mermaidSvgCache.get(info.hash)
      if (cached) {
        fillMermaidSlot(slotEl, cached)
        return
      }
      slotEl.style.minHeight = '200px' // stable placeholder before lazy render (scroll-sync)
      mermaidObserverRef.current?.observe(slotEl)
    })
  }, [sanitizedHtml])

  // D-E①: observe mermaid placeholders and render them when they scroll into view.
  useEffect(() => {
    const root = scrollRef.current
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement
            io.unobserve(el)
            void renderMermaidSlot(el, mermaidSlotsRef.current, tRef.current)
          }
        }
      },
      { root, rootMargin: '200px' },
    )
    mermaidObserverRef.current = io
    return () => io.disconnect()
  }, [])

  // D-B: inject the single github-markdown-css source of truth and keep it in sync with
  // the UI theme (no `.prose` / `.dark` toggle — plan-03 §4.1).
  useEffect(() => {
    injectMarkdownBodyStyles()
  }, [])
  useEffect(() => {
    const isDark = applyMarkdownBodyTheme(theme)
    const el = previewRef.current
    // Unreachable false branch: the ref is attached whenever this effect runs.
    /* v8 ignore next */
    if (el) {
      el.setAttribute('data-theme', isDark ? 'dark' : 'light')
    }
  }, [theme])

  useEffect(() => {
    const el = scrollRef.current
    // Unreachable: the scroll container is rendered unconditionally.
    /* v8 ignore next */
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
        <article
          ref={previewRef}
          tabIndex={0}
          role="document"
          lang={lang ?? undefined}
          className="markdown-body markdown-preview max-w-none px-6 py-6 w-full"
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              !e.shiftKey &&
              !e.altKey &&
              e.key.toLowerCase() === 'a'
            ) {
              e.preventDefault()
              window.getSelection()?.selectAllChildren(e.currentTarget)
            }
          }}
          onCopy={(e) => {
            const article = e.currentTarget
            const payload = consumePendingCopy() ?? buildPreviewCopyPayload(article)
            // Cold cache: the payload carries a diagram whose PNG isn't rasterized yet, and this
            // synchronous event cannot await it — shipping now would drop the diagram. Defer: let
            // deferWarmCopy finish the bake, rebuild the payload and re-fire the native copy, which
            // re-enters here with a warm cache (single retry). deferColdCopy declines (and we write
            // immediately) when the payload awaits no diagram, or when the native copy cannot be
            // re-fired at all — deferring there would silently copy nothing.
            if (deferColdCopy(article, payload)) {
              e.preventDefault()
              return
            }
            // Plan 04: upgrade the bare HTML to a Word/Confluence/Excel-ready payload
            // (inline styles + rasterized mermaid/math + light theme), then strip the
            // pipeline's internal markers as the final step (enhanceForPaste). The `safe`
            // wrapper never throws: a fidelity failure must still preventDefault, never let
            // the browser copy the raw un-styled DOM.
            const finalHtml = safeEnhanceForPaste(payload.html)
            try {
              e.clipboardData?.setData('text/plain', payload.text)
              e.clipboardData?.setData('text/html', finalHtml)
              e.preventDefault()
            } catch {
              /* setData failed: leave the default copy in place */
            }
          }}
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
