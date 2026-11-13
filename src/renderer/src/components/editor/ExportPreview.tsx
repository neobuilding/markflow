import React, { useEffect, useRef, useState } from 'react'
import { buildExportParts, type ExportParts } from '../../lib/export'
import { prepareExportHtml } from '../../lib/exportBake'
import { useUIStore } from '../../store/ui'
import { useT } from '../../i18n'

// C20 ⑨ — "export preview".
//
// The preview must show what the FILE will contain, not what the app looks like. So it renders
// the export's OWN stylesheet inside a shadow root: the app's `github-markdown-css` injection and
// `globals.css` overrides cannot leak in (shadow isolation), which is the whole point — if the
// preview borrowed the app's styling, the feature would prove nothing.
//
// Two hard constraints, both measured (S1/S2):
//   S1  A shadow root does NOT register fonts. Chromium only picks up `@font-face` rules that
//       live in the HOST document, so the KaTeX font declarations go to `document.head` while
//       the document CSS goes into the shadow root.
//   S2  `body` does not match inside a shadow root, so the export's document-level custom
//       properties land on `:host` and the container declarations on the preview container.

const HOST_FONT_STYLE_ID = 'markflow-export-preview-fonts'
/** Marks the four <style> elements inside the shadow root so they can be updated in place. */
const PART_ATTR = 'data-export-part'

/**
 * S1: publish the @font-face rules in the host document (once, then update in place).
 *
 * They are ~254KB of base64 font data, so the preview REMOVES the element when it unmounts —
 * otherwise merely opening the export dialog once would pin that CSS in `document.head` for the
 * rest of the session.
 */
function ensureHostFontCss(fontCss: string): void {
  if (!fontCss) return
  let el = document.getElementById(HOST_FONT_STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = HOST_FONT_STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== fontCss) el.textContent = fontCss
}

function removeHostFontCss(): void {
  document.getElementById(HOST_FONT_STYLE_ID)?.remove()
}

// Which ExportPreview instance currently owns the shared host-document font <style>. A shadow root
// does not register @font-face, so the faces live on a single <style id={HOST_FONT_STYLE_ID}> in
// document.head (see S1). Because that element is shared by every instance, a deferred removal from
// one unmount must NOT delete the sheet a newer instance has already re-created — so ownership is a
// module-level identity, not a per-instance ref (the previous per-instance ref let a stale timer
// remove a sheet a second instance already owned).
let fontSheetOwner: object | null = null

interface ShadowParts {
  css: HTMLStyleElement
  hostVars: HTMLStyleElement
  containerCss: HTMLStyleElement
  print: HTMLStyleElement
  markdownBody: HTMLElement
}

/**
 * Create (or find) the shadow root's fixed skeleton. Building the skeleton once and updating the
 * pieces in place matters: a theme switch must NOT rebuild the body, or every embedded image is
 * re-decoded and the user's scroll position resets.
 */
function ensureShadow(host: HTMLElement): ShadowParts {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const style = (part: string): HTMLStyleElement => {
    let el = root.querySelector<HTMLStyleElement>(`style[${PART_ATTR}="${part}"]`)
    if (!el) {
      el = document.createElement('style')
      el.setAttribute(PART_ATTR, part)
      root.appendChild(el)
    }
    return el
  }
  const css = style('css')
  const hostVars = style('host-vars')
  const containerCss = style('container')
  const print = style('print')
  let markdownBody = root.querySelector<HTMLElement>('.markdown-body')
  if (!markdownBody) {
    const container = document.createElement('div')
    container.className = 'export-preview-container'
    markdownBody = document.createElement('div')
    markdownBody.className = 'markdown-body'
    container.appendChild(markdownBody)
    root.appendChild(container)
  }
  return { css, hostVars, containerCss, print, markdownBody }
}

export function ExportPreview({ theme }: { theme: 'light' | 'dark' }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [parts, setParts] = useState<ExportParts | null>(null)
  const [failed, setFailed] = useState(false)
  // The export cache is a non-reactive singleton; its readiness is mirrored in the store (C20 ⑦).
  // While it is false the cache still holds the PREVIOUS document's HTML, so the preview must
  // not render that — it waits for the real document, then rebuilds.
  const exportReady = useUIStore((s) => s.exportReady)
  // The body is theme-independent, so a theme change reuses it instead of re-running the image
  // IPC (base64-inlining every local image is the expensive half of building the parts). The
  // cache dies with the component, i.e. with the dialog: reopening always rebuilds.
  const bodyCache = useRef<{ ready: boolean; html: string } | null>(null)
  const { t } = useT()

  // S1 lifecycle: the host-document font sheet must not outlive the preview (~254KB of base64
  // font data would otherwise stay pinned in `document.head` for the rest of the session).
  //
  // The removal is deferred one tick on purpose: React's StrictMode double-invokes effects in dev
  // (mount → cleanup → mount) while `parts` stays identical, so the styles effect does NOT re-run
  // and a synchronous removal would leave the second mount without any @font-face. Ownership is a
  // module-level identity (see `fontSheetOwner`): when this instance unmounts it clears the owner and
  // only removes the shared sheet if no newer instance has since claimed it, so a stale deferred
  // removal can never delete a sheet a second instance already owns.
  const fontSheetToken = useRef<object>({})
  useEffect(() => {
    fontSheetOwner = fontSheetToken.current
    return () => {
      fontSheetOwner = null
      setTimeout(() => {
        if (fontSheetOwner === null) removeHostFontCss()
      }, 0)
    }
  }, [])

  useEffect(() => {
    if (!exportReady) return
    let cancelled = false
    void (async () => {
      try {
        // The export bakes EVERY diagram in the document (ADR 0019); the preview has to show
        // the same document, otherwise "the preview has the diagram but the export does not"
        // (or the reverse) would be indistinguishable from a broken export.
        await prepareExportHtml()
        const cached = bodyCache.current?.ready === exportReady ? bodyCache.current.html : undefined
        // Images are always inlined for the preview: in the non-inline mode the export rewrites
        // `appdoc://` to a RELATIVE path, which inside a shadow root would resolve against the
        // host document's base URL and break every image (measured constraint W3).
        const built = await buildExportParts({ theme, embedImages: true, body: cached })
        bodyCache.current = { ready: exportReady, html: built.body }
        if (!cancelled) {
          setParts(built)
          setFailed(false)
        }
      } catch (e) {
        console.error('Export preview failed', e)
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [theme, exportReady])

  // Styles + theme: updated on every rebuild (cheap — no DOM structure change).
  useEffect(() => {
    const host = hostRef.current
    if (!host || !parts) return
    ensureHostFontCss(parts.fontCss)
    const s = ensureShadow(host)
    s.css.textContent = parts.css
    // The preview host must paint the EXPORTED page's own background, not the app chrome's. In the
    // standalone file the page is `<body class="markdown-body">`, whose `--bgColor-default` (white in
    // light / #0d1117 in dark, from github-markdown-css) propagates to the whole canvas — so the page
    // is edge-to-edge with no app-coloured margin. Mirroring that value on `:host` and using it for the
    // host's own background removes the grey `--color-bg` ring the preview used to show around the page
    // (the export's `body` padding lives on the transparent `.export-preview-container`, which only
    // looked like a frame because the host behind it was the app colour). C20 ⑨: "the preview must show
    // what the FILE will contain."
    const pageBg = parts.theme === 'dark' ? '#0d1117' : '#ffffff'
    s.hostVars.textContent = `:host{${parts.rootVars} --bgColor-default: ${pageBg};}`
    s.containerCss.textContent = `.export-preview-container{${parts.containerCss}}`
    s.print.textContent = parts.printCss
    s.markdownBody.setAttribute('data-theme', parts.theme)
  }, [parts])

  // Body: rewritten only when the document itself changed.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !parts) return
    const s = ensureShadow(host)
    if (s.markdownBody.innerHTML !== parts.body) s.markdownBody.innerHTML = parts.body
  }, [parts])

  const showPending = !parts && !failed

  // The dialog owns resizing (R4): it is draggable by its title bar and resizable from its edges,
  // so the preview simply fills whatever space the dialog gives it. The min/max sizes that used to
  // live on this pane now belong to the dialog's resize constraints.
  //
  // The host element is also the SCROLL container (the shadow tree lays out inside it), and it
  // keeps the `group` role + label the pane carried before: the dialog's caption above it is a
  // plain `<label>`, so without this the region a screen reader announces as "Preview" is gone.
  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={hostRef}
        role="group"
        aria-label={t('export.previewTitle')}
        data-testid="export-preview"
        className="relative w-full h-full overflow-auto overscroll-contain rounded border border-[var(--color-border-strong)] bg-[var(--bgColor-default,#ffffff)]"
      >
        {(showPending || failed) && (
          <p className="text-2xs text-[var(--color-text-tertiary)] p-3">
            {failed ? t('export.previewUnavailable') : t('export.preparing')}
          </p>
        )}
      </div>
      {/* Sunken-well affordance ("the preview is a scroll viewport", NOT document content). It is a
          SIBLING of the scroll container (not inside it, not a shadow-tree ::after) so it does NOT
          scroll away with the page — a ::after anchored to the scroll container scrolls off on
          scroll. It paints above the page as pure viewport chrome; pointer-events-none lets wheel
          and clicks reach the host. Soft slate tint; near-invisible on the dark page, where
          border-strong carries the boundary. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded shadow-[inset_0_2px_8px_rgba(15,23,42,0.12)]"
      />
    </div>
  )
}
