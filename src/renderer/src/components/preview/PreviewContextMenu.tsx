import React, { useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useT } from '../../i18n'
import type { Document } from '../../types'
import { getExportHtml } from '../../lib/exportStore'
import { requestRichCopy, svgToPngDataUrl } from '../../lib/previewCopy'
import { formulaToPng } from '../../lib/formulaImage'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
} from '../ui/context-menu'
import {
  Copy,
  List,
  ExternalLink,
  FolderOpen,
  Printer,
  FileOutput,
  Image as ImageIcon,
  Save,
  FileImage,
  FileText,
} from 'lucide-react'

// Right-click menu for the preview surface. The kind is detected from the element under the
// cursor at open time: a link, an image (bitmap or mermaid SVG), a KaTeX formula, or the generic
// article.
// Plan 02 (D3): the old per-object "copy source / copy X" items are gone — a single rich-text
// "Copy" now covers headings, code, tables, lists and formulas, so the menu stays small. The one
// exception is a formula's "Copy as image" (ADR 0020): the payload keeps MathML, and targets that
// render neither MathML nor KaTeX's CSS need the bitmap as an explicit, separate action.
type TargetKind = 'generic' | 'link' | 'image' | 'formula'

interface PreviewContextMenuProps {
  doc: Document | null | undefined
  children: React.ReactNode
  // Ref to the preview <article> so copy/select can read its text directly instead
  // of querying the DOM by class. Optional for flexibility in tests
  previewRef?: React.RefObject<HTMLDivElement | null>
}

export function PreviewContextMenu({ doc, children, previewRef }: PreviewContextMenuProps) {
  const { t } = useT()
  const viewMode = useUIStore((s) => s.viewMode)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const [kind, setKind] = useState<TargetKind>('generic')
  const [linkHref, setLinkHref] = useState('')
  // Bitmap image state (kind === 'image' && !isSvg)
  const [imgSrc, setImgSrc] = useState('')
  // Mermaid / vector image state (kind === 'image' && isSvg)
  const [isSvg, setIsSvg] = useState(false)
  const [mermaidSvg, setMermaidSvg] = useState('')
  // Formula state (kind === 'formula'): the rendered `.katex` node that gets rasterized.
  const [formulaEl, setFormulaEl] = useState<HTMLElement | null>(null)

  // Capture-phase handler: classify the context target before the menu opens.
  const capture = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const img = target.closest('img')
    const mermaidEl = target.closest('[data-mermaid-slot]')
    const href = target.closest('a')?.getAttribute('href')
    if (img) {
      setKind('image')
      setIsSvg(false)
      setImgSrc(img.getAttribute('src') ?? '')
    } else if (mermaidEl) {
      // A rendered mermaid diagram: the wrapper carries the SVG markup inside; treat it as a
      // vector image so the menu offers rasterized "Copy Image" + vector "Copy SVG" (D4).
      const svgEl = mermaidEl.querySelector('svg')
      setKind('image')
      setIsSvg(true)
      setMermaidSvg(svgEl ? svgEl.outerHTML : mermaidEl.innerHTML)
    } else if (href) {
      setKind('link')
      setLinkHref(href)
    } else {
      // A rendered KaTeX formula: right-click anywhere on it — including the empty margin of a
      // block-level `.katex-display` — to copy a bitmap for targets that render neither MathML
      // nor KaTeX's CSS (ADR 0020). Link precedence is unchanged: a formula inside a link still
      // offers the link menu, because that is what the surrounding text promised.
      const holder = target.closest<HTMLElement>('.katex, .katex-display')
      const katex = holder?.classList.contains('katex')
        ? holder
        : (holder?.querySelector<HTMLElement>('.katex') ?? null)
      if (katex) {
        setKind('formula')
        setFormulaEl(katex)
        return
      }
      setKind('generic')
    }
  }

  // Rich-text copy (Plan 02): drives the article's `copy` event via requestRichCopy, which
  // builds a clean { text, html } payload and writes it as text/plain + text/html. Selection
  // priority, whole-article fallback and cross-pane guard all live in previewCopy.ts so the
  // keyboard Ctrl+C and this menu item produce identical output (R3).
  const copyPreview = () => {
    const el = previewRef?.current
    if (el) void requestRichCopy(el)
  }
  const selectAllPreview = () => {
    const article = previewRef?.current
    /* v8 ignore next -- defensive: the preview article always exists when the menu is shown */
    if (!article) return
    window.getSelection()?.selectAllChildren(article)
  }
  const printPreview = () => {
    void window.api.export.print(getExportHtml())
  }

  // ── Link actions ──
  const openLink = () => void window.api.app.openExternal(linkHref)
  const copyLink = () => void window.api.clipboard.writeText(linkHref)

  // ── Image actions ──
  // Copy Image: a bitmap is handed to the main process as-is; a mermaid SVG is rasterized to
  // a PNG `data:` URL first (clipboard:write-image was extended to accept `data:` URLs).
  const copyImage = () => {
    if (isSvg) {
      void svgToPngDataUrl(mermaidSvg)
        .then((png) => window.api.clipboard.writeImage(png))
        /* v8 ignore start -- defensive: a rejected rasterization is intentionally swallowed */
        .catch(() => {})
      /* v8 ignore stop */
    } else {
      void window.api.clipboard.writeImage(imgSrc)
    }
  }
  // Copy Image Address: resolve an appdoc:// reference to its on-disk path so the copied
  // "address" is a real file location; external URLs are copied as-is.
  const copyImageAddress = async () => {
    const resolved = imgSrc.startsWith('appdoc://')
      ? await window.api.documents.resolveAppdoc(imgSrc)
      : imgSrc
    void window.api.clipboard.writeText(resolved || imgSrc)
  }
  const showImageInFolder = async () => {
    if (!imgSrc.startsWith('appdoc://')) {
      /* v8 ignore next -- defensive: a rejected showInFolder is intentionally swallowed */
      void Promise.resolve(window.api.app.showInFolder(imgSrc)).catch(() => {})
      return
    }
    const resolved = await window.api.documents.resolveAppdoc(imgSrc)
    /* v8 ignore next -- defensive: a rejected showInFolder is intentionally swallowed */
    if (resolved) void Promise.resolve(window.api.app.showInFolder(resolved)).catch(() => {})
  }
  // A remote image has no local file to reveal, so the item is greyed out instead of
  // failing silently when clicked.
  const isRemoteImage = /^https?:\/\//i.test(imgSrc)
  const saveImageAs = async () => {
    if (isSvg) {
      // Vector image: save the SVG markup to a .svg file (plan §4.6).
      const p = await window.api.dialog.saveFile('diagram.svg')
      if (p) await window.api.export.write(p, mermaidSvg)
    } else {
      const name = imgSrc.split(/[\\/]/).pop() || 'image'
      const p = await window.api.dialog.saveFile(name)
      if (p) await window.api.app.copyFile(imgSrc, p)
    }
  }
  // Copy SVG: vector form, written by the main process as image/svg+xml (+ a text/html
  // wrapper) so it pastes cleanly into Word / vector editors (D4).
  const copySvg = () => void window.api.clipboard.writeSvg(mermaidSvg)

  // ── Formula action ──
  // "Copy formula as image" (ADR 0020): the rich-text payload keeps MathML, which Word / OneNote
  // turn into editable equations; a bitmap would be a downgrade there. It is opt-in for the
  // targets that render neither MathML nor KaTeX's CSS (F23). Silent on failure, like copyImage.
  const copyFormulaImage = async () => {
    /* v8 ignore next -- defensive: kind === 'formula' always carries a captured element */
    if (!formulaEl) return
    const png = await formulaToPng(formulaEl)
    if (png) void window.api.clipboard.writeImage(png)
  }

  // The generic copy / select-all pair is shared by every variant.
  const copyAndSelectAll = (
    <>
      <ContextMenuItem data-testid="preview-copy" onClick={copyPreview}>
        <Copy size={13} /> {t('ctx.copy')}
      </ContextMenuItem>
      <ContextMenuItem data-testid="preview-select-all" onClick={selectAllPreview}>
        <List size={13} /> {t('ctx.selectAll')}
      </ContextMenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenuCapture={capture}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {kind === 'link' && (
          <>
            <ContextMenuItem data-testid="preview-open-link" onClick={openLink}>
              <ExternalLink size={13} /> {t('ctx.openLink')}
            </ContextMenuItem>
            <ContextMenuItem data-testid="preview-copy-link" onClick={copyLink}>
              <Copy size={13} /> {t('ctx.copyLink')}
            </ContextMenuItem>
            {copyAndSelectAll}
          </>
        )}
        {kind === 'image' && !isSvg && (
          <>
            <ContextMenuItem data-testid="preview-copy-image" onClick={copyImage}>
              <ImageIcon size={13} /> {t('ctx.copyImage')}
            </ContextMenuItem>
            <ContextMenuItem data-testid="preview-save-image-as" onClick={() => void saveImageAs()}>
              <Save size={13} /> {t('ctx.saveImageAs')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="preview-copy-image-address"
              onClick={() => void copyImageAddress()}
            >
              <Copy size={13} /> {t('ctx.copyImageSrc')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-show-image-in-folder"
              disabled={!imgSrc || isRemoteImage}
              onClick={() => void showImageInFolder()}
            >
              <FolderOpen size={13} /> {t('editor.showInFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'image' && isSvg && (
          <>
            <ContextMenuItem data-testid="preview-copy-image" onClick={copyImage}>
              <ImageIcon size={13} /> {t('ctx.copyImage')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-svg"
              disabled={!mermaidSvg}
              onClick={copySvg}
            >
              <FileImage size={13} /> {t('ctx.copySvg')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-save-image-as"
              disabled={!mermaidSvg}
              onClick={() => void saveImageAs()}
            >
              <Save size={13} /> {t('ctx.saveImageAs')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'formula' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-formula-image"
              onClick={() => void copyFormulaImage()}
            >
              <ImageIcon size={13} /> {t('ctx.copyFormulaImage')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'generic' && (
          <>
            {copyAndSelectAll}
            <ContextMenuSeparator />
            <ContextMenuCheckboxItem
              data-testid="preview-view-editor"
              checked={viewMode === 'edit'}
              onCheckedChange={() => setViewMode('edit')}
            >
              {t('editor.view.editor')}
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              data-testid="preview-view-split"
              checked={viewMode === 'split'}
              onCheckedChange={() => setViewMode('split')}
            >
              {t('editor.view.split')}
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              data-testid="preview-view-preview"
              checked={viewMode === 'preview'}
              onCheckedChange={() => setViewMode('preview')}
            >
              {t('editor.view.preview')}
            </ContextMenuCheckboxItem>
            <ContextMenuSeparator />
            <ContextMenuItem data-testid="preview-print" onClick={printPreview}>
              <Printer size={13} /> {t('menu.print')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-export-html"
              onClick={() => useUIStore.getState().setExportOpen(true)}
            >
              <FileOutput size={13} /> {t('editor.export')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="preview-copy-path"
              disabled={!doc?.filePath}
              onClick={() => void window.api.clipboard.writeText(doc?.filePath as string)}
            >
              <FileText size={13} />
              {t('editor.copyFullPath')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-show-in-folder"
              disabled={!doc?.filePath}
              onClick={() =>
                void Promise.resolve(window.api.app.showInFolder(doc?.filePath as string)).catch(
                  /* v8 ignore next -- defensive: a rejected showInFolder is intentionally swallowed */
                  () => {},
                )
              }
            >
              <FolderOpen size={13} /> {t('editor.showInFolder')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
