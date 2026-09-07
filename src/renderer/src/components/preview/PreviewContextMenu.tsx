import React, { useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useT } from '../../i18n'
import type { Document } from '../../types'
import { getExportHtml } from '../../lib/exportStore'
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
  Code2,
  FileText,
  Table,
  Heading,
  CheckSquare,
  Image as ImageIcon,
  Save,
  FileImage,
} from 'lucide-react'

// Right-click menu for the preview surface . The variant is detected from the
// element under the cursor at open time: a link, a code block, a table, a heading, a task
// list item, an image, a formula, a diagram, or the generic article.
type TargetKind =
  'generic' | 'link' | 'code' | 'table' | 'heading' | 'task' | 'image' | 'formula' | 'mermaid'

interface PreviewContextMenuProps {
  doc: Document | null | undefined
  children: React.ReactNode
  // Ref to the preview <article> so copy/select can read its text directly instead
  // of querying the DOM by class . Optional for flexibility in tests
  previewRef?: React.RefObject<HTMLDivElement | null>
}

// ── Pure extraction helpers (module scope: they only read the DOM, never React state) ──

function cellText(cell: Element): string {
  // Element.textContent is typed `string | null` but is never null for a real element
  // (both jsdom and Chromium return '' for an empty one).
  /* v8 ignore next -- Element.textContent is typed nullable but is never null for real elements */
  return (cell.textContent ?? '').trim()
}

function tableRows(table: Element): string[][] {
  return Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map(cellText),
  )
}

// Markdown pipe table: the first row is the header (GFM has no header-less table), with a
// `---` delimiter row underneath it.
function tableToMarkdown(table: Element): string {
  const rows = tableRows(table)
  if (rows.length === 0) return ''
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const [header, ...body] = rows
  return [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n')
}

// TSV: tabs separate the cells, so pasting into Excel / WPS / Numbers splits into columns.
// Chosen over CSV because cell text often contains commas
function tableToTsv(table: Element): string {
  return tableRows(table)
    .map((row) => row.join('\t'))
    .join('\n')
}

export function PreviewContextMenu({ doc, children, previewRef }: PreviewContextMenuProps) {
  const { t } = useT()
  const viewMode = useUIStore((s) => s.viewMode)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const [kind, setKind] = useState<TargetKind>('generic')
  const [linkHref, setLinkHref] = useState('')
  const [codeText, setCodeText] = useState('')
  const [codeLang, setCodeLang] = useState('')
  const [tableMarkdown, setTableMarkdown] = useState('')
  const [tableTsv, setTableTsv] = useState('')
  const [headingText, setHeadingText] = useState('')
  const [headingId, setHeadingId] = useState('')
  const [taskText, setTaskText] = useState('')
  // Preview P2 variants ( / / / )
  const [imgSrc, setImgSrc] = useState('')
  // Alt text of the right-clicked image. Kept as a raw string so an image without alt
  // greys the item out instead of copying an empty string.
  const [imgAlt, setImgAlt] = useState('')
  // Formula TeX source (KaTeX <annotation encoding="application/x-tex">). jsdom cannot
  // render KaTeX (DOMPurify drops the annotation), so this branch is only exercised by e2e.
  const [formulaSrc, setFormulaSrc] = useState('')
  // The formula as rendered (the visible glyphs), as opposed to its TeX source.
  const [formulaText, setFormulaText] = useState('')
  const [mermaidSrc, setMermaidSrc] = useState('')
  const [mermaidSvg, setMermaidSvg] = useState('')

  // Capture-phase handler: classify the context target before the menu opens.
  const capture = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const img = target.closest('img')
    const mermaidEl = target.closest('[data-mermaid-slot]')
    const katexEl = target.closest('.katex')
    const href = target.closest('a')?.getAttribute('href')
    const pre = target.closest('pre')
    const table = target.closest('table')
    const heading = target.closest('h1,h2,h3,h4,h5,h6')
    // A GFM task item is an <li> whose descendant is a disabled checkbox; the checkbox
    // itself carries no text, so the item's textContent is exactly the task text.
    const li = target.closest('li')
    const taskItem = li && li.querySelector('input[type="checkbox"]') ? li : null
    if (img) {
      setKind('image')
      setImgSrc(img.getAttribute('src') ?? '')
      setImgAlt(img.getAttribute('alt') ?? '')
    } else if (mermaidEl) {
      // The rendered wrapper carries the raw mermaid source () and the
      // SVG markup inside it exactly what "Copy diagram source" / "Save diagram" need
      setKind('mermaid')
      setMermaidSrc(mermaidEl.getAttribute('data-mermaid-source') ?? '')
      setMermaidSvg(mermaidEl.innerHTML)
    } else if (katexEl) {
      // KaTeX renders the TeX source into <annotation encoding="application/x-tex">.
      // jsdom drops it through the real pipeline, but a unit test can inject the node
      // directly, so this branch is still covered
      const ann = katexEl.querySelector('annotation[encoding="application/x-tex"]')
      setKind('formula')
      setFormulaSrc(ann?.textContent ?? '')
      // KaTeX renders the visible glyphs into `.katex-html` and the (hidden) MathML
      // which carries the TeX source in <annotation> into `.katex-mathml`. Reading
      // `.katex.textContent` would mix both, so the MathML subtree is dropped first.
      const clone = katexEl.cloneNode(true) as HTMLElement
      clone.querySelectorAll('.katex-mathml').forEach((n) => n.remove())
      /* v8 ignore next -- Element.textContent is typed nullable but is never null for real elements */
      setFormulaText((clone.textContent ?? '').trim())
    } else if (href) {
      setKind('link')
      setLinkHref(href)
    } else if (pre) {
      const code = pre.querySelector('code')
      setKind('code')
      setCodeText(code?.textContent ?? '')
      setCodeLang(code?.getAttribute('data-lang') ?? '')
    } else if (table) {
      setKind('table')
      setTableMarkdown(tableToMarkdown(table))
      setTableTsv(tableToTsv(table))
    } else if (heading) {
      setKind('heading')
      setHeadingId(heading.id)
      /* v8 ignore next -- Element.textContent is typed nullable but is never null for real elements */
      setHeadingText(heading.textContent ?? '')
    } else if (taskItem) {
      setKind('task')
      /* v8 ignore next -- Element.textContent is typed nullable but is never null for real elements */
      setTaskText((taskItem.textContent ?? '').trim())
    } else {
      setKind('generic')
    }
  }

  const copySelectionOrAll = () => {
    const article = previewRef?.current ?? null
    const sel = window.getSelection()?.toString()
    const text = sel || article?.textContent || ''
    void window.api.clipboard.writeText(text)
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
  // ── Preview P2 handlers ( / / / ) ──
  const copyImage = () => void window.api.clipboard.writeImage(imgSrc)
  const copyImageAddress = async () => {
    // Resolve an appdoc:// reference to its on-disk path so the copied "address" is a
    // real file location; external URLs are copied as-is.
    const resolved = imgSrc.startsWith('appdoc://')
      ? await window.api.documents.resolveAppdoc(imgSrc)
      : imgSrc
    void window.api.clipboard.writeText(resolved || imgSrc)
  }
  const showImageInFolder = async () => {
    if (!imgSrc.startsWith('appdoc://')) {
      void Promise.resolve(window.api.app.showInFolder(imgSrc)).catch(() => {})
      return
    }
    const resolved = await window.api.documents.resolveAppdoc(imgSrc)
    if (resolved) void Promise.resolve(window.api.app.showInFolder(resolved)).catch(() => {})
  }
  // A remote image has no local file to reveal, so the item is greyed out instead of
  // failing silently when clicked.
  const isRemoteImage = /^https?:\/\//i.test(imgSrc)
  const saveImageAs = async () => {
    const name = imgSrc.split(/[\\/]/).pop() || 'image'
    const p = await window.api.dialog.saveFile(name)
    if (p) await window.api.app.copyFile(imgSrc, p)
  }
  const saveSvgAs = async () => {
    const p = await window.api.dialog.saveFile('diagram.svg')
    if (p) await window.api.export.write(p, mermaidSvg)
  }
  // "Copy as fenced block": wraps the code in a ``` fence, keeping the language when the
  // block declared one
  const fencedCode = '```' + codeLang + '\n' + codeText + '\n```'

  // The generic copy / select-all pair is shared by every variant.
  const copyAndSelectAll = (
    <>
      <ContextMenuItem data-testid="preview-copy" onClick={copySelectionOrAll}>
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
            <ContextMenuItem
              data-testid="preview-open-link"
              onClick={() => void window.api.app.openExternal(linkHref)}
            >
              <ExternalLink size={13} /> {t('ctx.openLink')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-link"
              onClick={() => void window.api.clipboard.writeText(linkHref)}
            >
              <Copy size={13} /> {t('ctx.copyLink')}
            </ContextMenuItem>
            {copyAndSelectAll}
          </>
        )}
        {kind === 'image' && (
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
            <ContextMenuItem
              data-testid="preview-copy-image-alt"
              disabled={!imgAlt}
              onClick={() => void window.api.clipboard.writeText(imgAlt)}
            >
              <Copy size={13} /> {t('ctx.copyImageAlt')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'formula' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-formula-latex"
              disabled={!formulaSrc}
              onClick={() => void window.api.clipboard.writeText(formulaSrc)}
            >
              <Code2 size={13} /> {t('ctx.copyFormulaSource')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-formula"
              disabled={!formulaText}
              onClick={() => void window.api.clipboard.writeText(formulaText)}
            >
              <FileText size={13} /> {t('ctx.copyFormula')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'mermaid' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-diagram-source"
              disabled={!mermaidSrc}
              onClick={() => void window.api.clipboard.writeText(mermaidSrc)}
            >
              <Code2 size={13} /> {t('ctx.copyDiagramSource')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-svg"
              disabled={!mermaidSvg}
              onClick={() => void window.api.clipboard.writeText(mermaidSvg)}
            >
              <FileImage size={13} /> {t('ctx.copySvg')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-save-svg-as"
              disabled={!mermaidSvg}
              onClick={() => void saveSvgAs()}
            >
              <Save size={13} /> {t('ctx.saveSvgAs')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'code' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-code"
              onClick={() => void window.api.clipboard.writeText(codeText)}
            >
              <Code2 size={13} /> {t('ctx.copyCode')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-code-block"
              onClick={() => void window.api.clipboard.writeText(fencedCode)}
            >
              <FileText size={13} /> {t('ctx.copyCodeBlock')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {/* Dynamic menu: when no language was declared the item is not generated at all ( 3) instead of showing a dead entry */}
            {codeLang && (
              <ContextMenuItem
                data-testid="preview-copy-lang"
                onClick={() => void window.api.clipboard.writeText(codeLang)}
              >
                <Code2 size={13} /> {t('ctx.copyLang')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'table' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-table"
              onClick={() => void window.api.clipboard.writeText(tableMarkdown)}
            >
              <Table size={13} /> {t('ctx.copyTable')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-table-tsv"
              onClick={() => void window.api.clipboard.writeText(tableTsv)}
            >
              <Table size={13} /> {t('ctx.copyTableTsv')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'heading' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-heading"
              onClick={() => void window.api.clipboard.writeText(headingText)}
            >
              <Heading size={13} /> {t('ctx.copyHeading')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-copy-anchor-id"
              disabled={!headingId}
              onClick={() => void window.api.clipboard.writeText(headingId)}
            >
              <Heading size={13} /> {t('ctx.copyAnchorId')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {copyAndSelectAll}
          </>
        )}
        {kind === 'task' && (
          <>
            <ContextMenuItem
              data-testid="preview-copy-task-text"
              onClick={() => void window.api.clipboard.writeText(taskText)}
            >
              <CheckSquare size={13} /> {t('ctx.copyTaskText')}
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
              <FileText size={13} /> {t('editor.copyFullPath')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="preview-show-in-folder"
              disabled={!doc?.filePath}
              onClick={() =>
                void Promise.resolve(window.api.app.showInFolder(doc?.filePath as string)).catch(
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
