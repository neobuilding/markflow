import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { PreviewContextMenu } from './PreviewContextMenu'
import { useUIStore } from '../../store/ui'
import type { Document } from '../../types'
import * as previewCopy from '../../lib/previewCopy'
import * as formulaImage from '../../lib/formulaImage'
import {
  buildPreviewCopyPayload,
  stripInternalAttrs,
  consumePendingCopy,
} from '../../lib/previewCopy'
import { setExportHtml } from '../../lib/exportStore'
import { sanitizeHtml } from '../../lib/sanitize'
import '../../i18n'

const docWithPath: Document = {
  id: 'a',
  title: 'Note A',
  folderPath: '/docs',
  content: '# A',
  filePath: '/docs/a.md',
  encoding: 'utf-8',
  encodingConfidence: 1,
  createdAt: 1,
  updatedAt: 1,
  wordCount: 3,
}

// Spy on the rich-copy primitives so the menu wiring can be asserted without relying on
// jsdom's non-functional execCommand('copy') / Image rasterization.
beforeEach(() => {
  useUIStore.getState().setViewMode('split')
  useUIStore.getState().setExportOpen(false)
  useUIStore.getState().requestFileAction(null)
  // Reset the canonical export HTML so buildPreviewCopyPayload's whole-article branch is
  // deterministic (it prefers getExportHtml() over article.innerHTML, contract #2).
  setExportHtml(sanitizeHtml(''))
  vi.spyOn(previewCopy, 'requestRichCopy').mockImplementation(() => Promise.resolve())
  vi.spyOn(previewCopy, 'svgToPngDataUrl').mockResolvedValue('data:image/png;base64,TESTPNG')
  // The formula variant rasterizes through the real <img>/<canvas> pipeline, which jsdom cannot
  // run at all; that half is covered by e2e (formula-copy-image.e2e.spec.ts).
  vi.spyOn(formulaImage, 'formulaToPng').mockResolvedValue('data:image/png;base64,FORMULA')
  ;(window as unknown as { api: unknown }).api = {
    clipboard: { writeText: vi.fn(), writeImage: vi.fn(), writeSvg: vi.fn() },
    app: { openExternal: vi.fn(), showInFolder: vi.fn(), copyFile: vi.fn() },
    export: {
      print: vi.fn(),
      write: vi.fn(),
      // No <img> in these fixtures, so embedImages is never exercised by the menu copy;
      // return the html unchanged if it ever is.
      embedImages: vi.fn(async (h: string) => h),
    },
    dialog: {
      confirm: vi.fn(async () => true),
      saveFile: vi.fn(async (name?: string) => '/tmp/' + (name ?? 'out')),
    },
    documents: {
      resolveAppdoc: vi.fn(async (s: string) => (s.startsWith('appdoc://') ? '/resolved/' + s : s)),
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mount(doc: Document | null | undefined) {
  const ref = createRef<HTMLDivElement>()
  return render(
    <PreviewContextMenu doc={doc} previewRef={ref}>
      <article className="markdown-preview" ref={ref}>
        <h1 data-line="0">Title</h1>
        <p>hello world</p>
        <a href="https://example.com/page">link</a>
      </article>
    </PreviewContextMenu>,
  )
}

function article() {
  return document.querySelector('.markdown-preview') as HTMLElement
}

// ── Rich-text copy payload builder (Plan 02 §4.1 / §4.2 / §4.5) ─────────────────────────
describe('buildPreviewCopyPayload', () => {
  // jsdom's Selection is unreliable (selectAllChildren / anchorNode), so drive the
  // in-preview check through an explicit fake selection — the unit under test is
  // buildPreviewCopyPayload, not the browser's selection engine.
  function mockSelection(anchorNode: Node | null, collapsed = false) {
    const range = {
      cloneContents: () => {
        const f = document.createDocumentFragment()
        const p = document.createElement('p')
        p.textContent = 'Only me'
        f.appendChild(p)
        return f
      },
      toString: () => 'Only me',
    } as unknown as Range
    const sel = {
      isCollapsed: collapsed,
      rangeCount: collapsed ? 0 : 1,
      anchorNode,
      getRangeAt: () => range,
      toString: () => 'Only me',
    } as unknown as Selection
    return vi.spyOn(window, 'getSelection').mockReturnValue(sel)
  }

  it('whole-article copy (no in-preview selection) keeps semantic structure and leaves internal markers intact (R6)', () => {
    mockSelection(null, true)
    const el = document.createElement('div')
    el.innerHTML =
      '<h1 data-line="0">T</h1><table data-line="2"><tr><td>a</td></tr></table>' +
      '<div data-mermaid-slot="0"><svg>g</svg></div>'
    const { html } = buildPreviewCopyPayload(el)
    expect(html).toContain('<h1')
    expect(html).toContain('<table')
    expect(html).toContain('<svg')
    // plan-04: build() no longer strips. The internal markers (data-line, data-mermaid-slot,
    // data-baked…) stay so the fidelity layer (enhanceForPaste in copyFidelity.ts) can locate
    // mermaid slots and finally strip them — that final strip is asserted in copyFidelity.test.ts.
    // Keeping the markers here guards the contract change from accidentally re-stripping upstream.
    expect(html).toContain('data-line')
    expect(html).toContain('data-mermaid-slot')
  })

  it('whole-article copy prefers the canonical export HTML (contract #2)', () => {
    mockSelection(null, true)
    // The canonical HTML (Phase 1 §5.5) carries data-line / data-lang / data-baked; the stale
    // live innerHTML must be ignored in favour of it.
    setExportHtml(
      sanitizeHtml('<pre data-line="0" data-lang="ts" data-baked="1"><code>x</code></pre>'),
    )
    const el = document.createElement('div')
    el.innerHTML = '<pre data-line="999"><code>STALE</code></pre>'
    const { html, text } = buildPreviewCopyPayload(el)
    // build() returns the canonical export HTML UNSTRIPPED; the fidelity layer (enhanceForPaste)
    // performs the final strip (verified in copyFidelity.test.ts). Here we only guard the
    // whole-article / canonical-preference contract.
    expect(html).toBe('<pre data-line="0" data-lang="ts" data-baked="1"><code>x</code></pre>')
    expect(text).toBe('x')
  })

  it('selection inside the preview is copied as a fragment, not the whole article', () => {
    const el = document.createElement('div')
    el.innerHTML = '<h1 id="h">Only me</h1><p id="p">other</p>'
    mockSelection(el.querySelector('#h')!)
    const { html, text } = buildPreviewCopyPayload(el)
    expect(html).toBe('<p>Only me</p>')
    expect(html).not.toContain('other')
    expect(text).toBe('Only me')
  })

  it('a selection anchored outside the preview falls back to the whole preview (cross-pane guard)', () => {
    const el = document.createElement('div')
    el.innerHTML = '<h1 id="h">Preview content</h1>'
    const editor = document.createElement('div')
    editor.innerHTML = '<p id="e">Editor text</p>'
    document.body.appendChild(editor)
    mockSelection(editor.querySelector('#e')!)
    try {
      const { html } = buildPreviewCopyPayload(el)
      expect(html).toContain('Preview content')
      expect(html).not.toContain('Editor text')
    } finally {
      document.body.removeChild(editor)
    }
  })
})

describe('stripInternalAttrs', () => {
  it('removes every internal marker (data-* pipeline attrs + anchor tabindex)', () => {
    const out = stripInternalAttrs(
      '<h1 id="keep-me" tabindex="-1">H</h1>' +
        '<p data-line="1" data-baked="1">x</p>' +
        '<pre data-lang="ts"><code>y</code></pre>' +
        '<div data-mermaid-slot="0"></div>',
    )
    expect(out).not.toContain('data-line')
    expect(out).not.toContain('data-lang')
    expect(out).not.toContain('data-baked')
    expect(out).not.toContain('data-mermaid-slot')
    expect(out).not.toContain('data-mermaid-source')
    // markdown-it-anchor puts tabindex="-1" on every heading; it must not be pasted.
    expect(out).not.toContain('tabindex')
    // …but the heading's anchor id is meaningful and is kept.
    expect(out).toContain('id="keep-me"')
  })
})

describe('PreviewContextMenu — generic', () => {
  it('Copy delegates to requestRichCopy (rich-text, Plan 02 §4.3)', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(previewCopy.requestRichCopy).toHaveBeenCalled()
  })

  it('select all selects the article content', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-select-all'))
    expect(window.getSelection()!.toString()).toContain('hello world')
  })

  it('view checkboxes toggle viewMode', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-view-editor'))
    expect(useUIStore.getState().viewMode).toBe('edit')
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-view-split'))
    expect(useUIStore.getState().viewMode).toBe('split')
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-view-preview'))
    expect(useUIStore.getState().viewMode).toBe('preview')
  })

  it('print calls export.print with the stashed html', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-print'))
    expect(window.api.export.print).toHaveBeenCalled()
  })

  it('export opens the export dialog', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-export-html'))
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  it('copy path and show in folder use doc.filePath', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-copy-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs/a.md')
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/a.md')
  })

  it('copy path and show in folder are disabled without a filePath (draft)', () => {
    mount(null)
    fireEvent.contextMenu(article())
    const copyPath = screen.getByTestId('preview-copy-path')
    const showInFolder = screen.getByTestId('preview-show-in-folder')
    expect(copyPath).toHaveAttribute('aria-disabled', 'true')
    expect(showInFolder).toHaveAttribute('aria-disabled', 'true')
  })

  it('does not throw and does not copy when there is no preview ref', async () => {
    render(
      <PreviewContextMenu doc={docWithPath}>
        <article className="markdown-preview">
          <p>hello world</p>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('hello world'))
    fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(previewCopy.requestRichCopy).not.toHaveBeenCalled()
  })
})

describe('PreviewContextMenu — link', () => {
  it('opens and copies the link address', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(screen.getByText('link'))
    fireEvent.click(await screen.findByTestId('preview-open-link'))
    expect(window.api.app.openExternal).toHaveBeenCalledWith('https://example.com/page')
    fireEvent.contextMenu(screen.getByText('link'))
    fireEvent.click(await screen.findByTestId('preview-copy-link'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('https://example.com/page')
  })

  it('also offers copy and select-all', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(screen.getByText('link'))
    expect(await screen.findByTestId('preview-copy')).toBeInTheDocument()
    const selectAll = await screen.findByTestId('preview-select-all')
    fireEvent.click(selectAll)
    expect(window.getSelection()!.toString()).toContain('hello world')
  })
})

function mountCustom(innerHtml: string, doc: Document | null = docWithPath) {
  const ref = createRef<HTMLDivElement>()
  return render(
    <PreviewContextMenu doc={doc} previewRef={ref}>
      <article
        className="markdown-preview"
        ref={ref}
        dangerouslySetInnerHTML={{ __html: innerHtml }}
      />
    </PreviewContextMenu>,
  )
}

describe('PreviewContextMenu — image (bitmap)', () => {
  it('copies the image to the clipboard', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image'))
    expect(window.api.clipboard.writeImage).toHaveBeenCalledWith('/img.png')
  })

  it('menu Copy inlines images via export.embedImages (R1: paste shows real pictures)', async () => {
    // Use the real requestRichCopy (not the beforeEach spy) so the image-inlining path
    // actually executes and calls export.embedImages.
    vi.spyOn(previewCopy, 'requestRichCopy').mockRestore()
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(window.api.export.embedImages).toHaveBeenCalled()
  })

  it('copies the on-disk address for a plain path', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-address'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/img.png'))
    expect(window.api.documents.resolveAppdoc).not.toHaveBeenCalled()
  })

  it('resolves an appdoc:// address before copying', async () => {
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-address'))
    await waitFor(() =>
      expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/resolved/appdoc://d1/im.png'),
    )
  })

  it('shows the file in its folder', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/img.png'))
  })

  it('saves the image as a chosen file', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() =>
      expect(window.api.app.copyFile).toHaveBeenCalledWith('/img.png', '/tmp/img.png'),
    )
  })

  it('greys out "show in folder" for a remote image', async () => {
    mountCustom('<img src="https://example.com/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    expect(await screen.findByTestId('preview-show-image-in-folder')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('offers copy + select-all (rich-text) on the image variant', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    expect(await screen.findByTestId('preview-copy')).toBeInTheDocument()
    expect(screen.getByTestId('preview-select-all')).toBeInTheDocument()
  })

  it('shows an appdoc:// image in its folder via the resolved on-disk path', async () => {
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() =>
      expect(window.api.app.showInFolder).toHaveBeenCalledWith('/resolved/appdoc://d1/im.png'),
    )
  })

  it('does nothing when the appdoc:// image cannot be resolved', async () => {
    vi.mocked(window.api.documents.resolveAppdoc).mockResolvedValueOnce(null as unknown as string)
    mountCustom('<img src="appdoc://d1/missing.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() => expect(window.api.documents.resolveAppdoc).toHaveBeenCalled())
    expect(window.api.app.showInFolder).not.toHaveBeenCalled()
  })

  it('falls back to "image" when the bitmap src has no filename', async () => {
    mountCustom('<img src="https://example.com/" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() =>
      expect(window.api.app.copyFile).toHaveBeenCalledWith('https://example.com/', '/tmp/image'),
    )
  })

  it('does nothing when the save dialog is cancelled (bitmap)', async () => {
    vi.mocked(window.api.dialog.saveFile).mockResolvedValueOnce(null as unknown as string)
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() => expect(window.api.dialog.saveFile).toHaveBeenCalled())
    expect(window.api.app.copyFile).not.toHaveBeenCalled()
  })

  it('greys out "show in folder" for an image with an empty src', async () => {
    mountCustom('<img src="" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    expect(await screen.findByTestId('preview-show-image-in-folder')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('handles an image element with no src attribute (null src → empty string)', async () => {
    mountCustom('<img />')
    fireEvent.contextMenu(screen.getByRole('img'))
    // The capture handler's `img.getAttribute('src') ?? ''` null branch is exercised here;
    // the menu still opens for the image variant.
    expect(await screen.findByTestId('preview-copy-image')).toBeInTheDocument()
  })

  it('copies the raw appdoc:// address when resolution fails (copyImageAddress fallback)', async () => {
    vi.mocked(window.api.documents.resolveAppdoc).mockResolvedValueOnce(null as unknown as string)
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-address'))
    // `resolved || imgSrc` takes the right operand when resolveAppdoc yields nothing.
    await waitFor(() =>
      expect(window.api.clipboard.writeText).toHaveBeenCalledWith('appdoc://d1/im.png'),
    )
  })
})

describe('PreviewContextMenu — image (mermaid SVG)', () => {
  const svg = '<svg>chart</svg>'
  const wrapper = `<div data-mermaid-slot="0">${svg}</div>`

  it('Copy Image rasterizes the SVG to a PNG data URL and copies it', async () => {
    mountCustom(wrapper)
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-image'))
    await waitFor(() =>
      expect(window.api.clipboard.writeImage).toHaveBeenCalledWith('data:image/png;base64,TESTPNG'),
    )
  })

  it('Copy SVG writes the vector markup', async () => {
    mountCustom(wrapper)
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-svg'))
    expect(window.api.clipboard.writeSvg).toHaveBeenCalledWith(svg)
  })

  it('Save Image as writes the SVG to a .svg file', async () => {
    mountCustom(wrapper)
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() =>
      expect(window.api.export.write).toHaveBeenCalledWith('/tmp/diagram.svg', svg),
    )
  })

  it('does NOT offer address / show-in-folder for a vector image (D4)', async () => {
    mountCustom(wrapper)
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    expect(await screen.findByTestId('preview-copy-svg')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-copy-image-address')).toBeNull()
    expect(screen.queryByTestId('preview-show-image-in-folder')).toBeNull()
    // Rich-text copy + select-all still present.
    expect(screen.getByTestId('preview-copy')).toBeInTheDocument()
  })

  it('handles a mermaid slot that rendered no <svg> (empty vector fallback)', async () => {
    // A wrapper carrying the slot marker but no baked SVG: `svgEl` is null, so `mermaidSvg`
    // falls back to the wrapper's innerHTML (here empty) and the vector items are disabled.
    mountCustom('<div data-mermaid-slot="0"></div>')
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    expect(await screen.findByTestId('preview-copy-svg')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('preview-save-image-as')).toHaveAttribute('aria-disabled', 'true')
    // Copy Image still rasterizes via the mocked svgToPngDataUrl.
    fireEvent.click(screen.getByTestId('preview-copy-image'))
    await waitFor(() =>
      expect(window.api.clipboard.writeImage).toHaveBeenCalledWith('data:image/png;base64,TESTPNG'),
    )
  })

  it('does nothing when the save dialog is cancelled (svg)', async () => {
    vi.mocked(window.api.dialog.saveFile).mockResolvedValueOnce(null as unknown as string)
    mountCustom(wrapper)
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() => expect(window.api.dialog.saveFile).toHaveBeenCalled())
    expect(window.api.export.write).not.toHaveBeenCalled()
  })
})

describe('PreviewContextMenu — requestRichCopy execCommand path', () => {
  // jsdom lacks a working `document.execCommand`, so the menu's `requestRichCopy` guard
  // (`if (typeof document.execCommand === 'function')`) normally skips the native copy.
  // These tests install a stand-in to exercise both the firing and the throwing branches.
  const setExec = (fn: unknown) => {
    ;(document as unknown as { execCommand: unknown }).execCommand = fn
  }
  const getExec = () => (document as unknown as { execCommand?: unknown }).execCommand

  it('fires a native execCommand("copy") when the DOM supports it', async () => {
    vi.spyOn(previewCopy, 'requestRichCopy').mockRestore()
    const exec = vi.fn()
    const orig = getExec()
    setExec(exec)
    try {
      mountCustom('<img src="/img.png" />')
      fireEvent.contextMenu(screen.getByRole('img'))
      fireEvent.click(await screen.findByTestId('preview-copy'))
      await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'))
      // An image-bearing copy still inlines via embedImages.
      expect(window.api.export.embedImages).toHaveBeenCalled()
    } finally {
      setExec(orig)
    }
  })

  it('never crashes when execCommand throws (swallowed by the guard)', async () => {
    vi.spyOn(previewCopy, 'requestRichCopy').mockRestore()
    const exec = vi.fn(() => {
      throw new Error('blocked')
    })
    const orig = getExec()
    setExec(exec)
    try {
      mountCustom('<img src="/img.png" />')
      fireEvent.contextMenu(screen.getByRole('img'))
      fireEvent.click(await screen.findByTestId('preview-copy'))
      // The pending payload is cleared even when execCommand throws, so a later copy
      // can't leak a stale payload.
      await waitFor(() => expect(consumePendingCopy()).toBeNull())
    } finally {
      setExec(orig)
    }
  })
})

describe('previewCopy — requestRichCopy branch coverage', () => {
  const setExec = (fn: unknown) => {
    ;(document as unknown as { execCommand: unknown }).execCommand = fn
  }
  const getExec = () => (document as unknown as { execCommand?: unknown }).execCommand

  // The outer beforeEach installs a mocked requestRichCopy; restore the real one so these
  // tests can drive its branches directly (deterministic — no fire-and-forget races).
  beforeEach(() => {
    vi.spyOn(previewCopy, 'requestRichCopy').mockRestore()
  })

  it('stripInternalAttrs returns an empty payload unchanged and strips markers otherwise', () => {
    expect(stripInternalAttrs('')).toBe('')
    expect(stripInternalAttrs('<h1 data-line="0">T</h1><p data-baked="1">x</p>')).toBe(
      '<h1>T</h1><p>x</p>',
    )
  })

  it('does not inline images for a text-only copy (no <img> in the payload)', async () => {
    const exec = vi.fn()
    const orig = getExec()
    setExec(exec)
    try {
      mountCustom('<p>just text</p>')
      await previewCopy.requestRichCopy(article())
      expect(window.api.export.embedImages).not.toHaveBeenCalled()
      expect(exec).toHaveBeenCalledWith('copy')
    } finally {
      setExec(orig)
    }
  })

  it('skips the native copy when execCommand is unavailable', async () => {
    const orig = getExec()
    setExec(undefined)
    try {
      mountCustom('<img src="/img.png" />')
      await previewCopy.requestRichCopy(article())
      expect(window.api.export.embedImages).toHaveBeenCalled()
    } finally {
      setExec(orig)
    }
  })

  it('preserves an in-preview selection and does not re-select the whole article', async () => {
    const orig = getExec()
    setExec(vi.fn())
    try {
      mountCustom('<p>hello world</p>')
      const sel = window.getSelection()!
      sel.removeAllRanges()
      const range = document.createRange()
      range.selectNodeContents(article())
      sel.addRange(range)
      await previewCopy.requestRichCopy(article())
      expect(window.getSelection()!.rangeCount).toBe(1)
    } finally {
      setExec(orig)
    }
  })
})

// ADR 0020 — a formula's bitmap is an OPT-IN action: rich-text copy keeps MathML (Word / OneNote
// turn it into editable equations), so the PNG is a separate menu item for the targets that
// render neither MathML nor KaTeX's CSS (F23). One clipboard cannot tell the targets apart.
describe('PreviewContextMenu — formula (KaTeX)', () => {
  const inlineFormula =
    '<p>see <span class="katex"><span class="katex-mathml"><math><annotation ' +
    'encoding="application/x-tex">E=mc^2</annotation></math></span><span class="katex-html">' +
    'E=mc<sup>2</sup></span></span> here</p>'
  const blockFormula =
    '<section><span class="katex-display"><span class="katex"><span class="katex-html">' +
    'x</span></span></span></section>'

  it('offers the bitmap item on an inline formula, next to the rich-text items', async () => {
    mountCustom(inlineFormula)
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    expect(await screen.findByTestId('preview-copy-formula-image')).toBeInTheDocument()
    expect(screen.getByTestId('preview-copy')).toBeInTheDocument()
    expect(screen.getByTestId('preview-select-all')).toBeInTheDocument()
  })

  it('writes the rasterized PNG to the clipboard', async () => {
    mountCustom(inlineFormula)
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-formula-image'))
    await waitFor(() =>
      expect(window.api.clipboard.writeImage).toHaveBeenCalledWith('data:image/png;base64,FORMULA'),
    )
  })

  it('is offered from the block-level container too, and rasterizes the inner .katex', async () => {
    mountCustom(blockFormula)
    // Right-click the full-width `.katex-display` (the margin around a centred formula), not the
    // formula itself: the item must still appear…
    fireEvent.contextMenu(document.querySelector('.katex-display') as HTMLElement)
    expect(await screen.findByTestId('preview-copy-formula-image')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('preview-copy-formula-image'))
    // …and the bitmap is taken from the tight `.katex` box, not the whole centred block.
    await waitFor(() => expect(formulaImage.formulaToPng).toHaveBeenCalled())
    const [el] = vi.mocked(formulaImage.formulaToPng).mock.calls[0]
    expect(el.classList.contains('katex')).toBe(true)
    expect(el.classList.contains('katex-display')).toBe(false)
  })

  it('falls back to the generic menu when the container holds no formula', async () => {
    mountCustom('<section><span class="katex-display"></span></section>')
    fireEvent.contextMenu(document.querySelector('.katex-display') as HTMLElement)
    expect(screen.queryByTestId('preview-copy-formula-image')).toBeNull()
    expect(await screen.findByTestId('preview-copy')).toBeInTheDocument()
  })

  it('copies nothing when the formula cannot be rasterized', async () => {
    vi.mocked(formulaImage.formulaToPng).mockResolvedValueOnce(null)
    mountCustom(inlineFormula)
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-formula-image'))
    await waitFor(() => expect(formulaImage.formulaToPng).toHaveBeenCalled())
    expect(window.api.clipboard.writeImage).not.toHaveBeenCalled()
  })

  it('does not offer the bitmap item on ordinary text', async () => {
    mountCustom('<p>plain text</p>')
    fireEvent.contextMenu(screen.getByText('plain text'))
    expect(await screen.findByTestId('preview-copy')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-copy-formula-image')).toBeNull()
  })
})
