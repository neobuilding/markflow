import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { PreviewContextMenu } from './PreviewContextMenu'
import { useUIStore } from '../../store/ui'
import type { Document } from '../../types'
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

beforeEach(() => {
  useUIStore.getState().setViewMode('split')
  useUIStore.getState().setExportOpen(false)
  useUIStore.getState().requestFileAction(null)
  ;(window as unknown as { api: unknown }).api = {
    clipboard: { writeText: vi.fn(), writeImage: vi.fn() },
    app: { openExternal: vi.fn(), showInFolder: vi.fn(), copyFile: vi.fn() },
    export: { print: vi.fn(), write: vi.fn() },
    dialog: { confirm: vi.fn(async () => true), saveFile: vi.fn(async () => '/out.svg') },
    documents: {
      resolveAppdoc: vi.fn(async (s: string) => (s.startsWith('appdoc://') ? '/resolved/' + s : s)),
    },
  }
})

function mount(doc: Document | null | undefined) {
  const ref = createRef<HTMLDivElement>()
  return render(
    <PreviewContextMenu doc={doc} previewRef={ref}>
      <article className="markdown-preview" ref={ref}>
        <p>hello world</p>
        <a href="https://example.com/page">link</a>
        <pre>
          <code>const a = 1;</code>
        </pre>
      </article>
    </PreviewContextMenu>,
  )
}

function article() {
  return document.querySelector('.markdown-preview') as HTMLElement
}

describe('PreviewContextMenu', () => {
  it('generic: copy uses the current selection when present', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    window.getSelection()!.selectAllChildren(article())
    fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith(article().textContent)
  })

  it('generic: copy falls back to article text when nothing is selected', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith(article().textContent)
  })

  it('generic: copy writes empty string when there is no text and no selection', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={null} previewRef={ref}>
        <article className="markdown-preview" ref={ref} />
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('')
  })

  it('generic: select all selects the article content', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-select-all'))
    expect(window.getSelection()!.toString()).toContain('hello world')
  })

  it('generic: view checkboxes toggle viewMode', async () => {
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

  it('generic: print calls export.print with the stashed html', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-print'))
    expect(window.api.export.print).toHaveBeenCalled()
  })

  it('generic: export opens the export dialog', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-export-html'))
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  it('generic: copy path and show in folder use doc.filePath', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-copy-path'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/docs/a.md')
    fireEvent.contextMenu(article())
    fireEvent.click(await screen.findByTestId('preview-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalledWith('/docs/a.md')
  })

  it('generic: copy path and show in folder are disabled without a filePath (draft)', () => {
    mount(null)
    fireEvent.contextMenu(article())
    const copyPath = screen.getByTestId('preview-copy-path')
    const showInFolder = screen.getByTestId('preview-show-in-folder')
    expect(copyPath).toHaveAttribute('aria-disabled', 'true')
    expect(showInFolder).toHaveAttribute('aria-disabled', 'true')
  })

  it('generic: show in folder swallows a failure gracefully', async () => {
    ;(window.api.app.showInFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    )
    mount(docWithPath)
    fireEvent.contextMenu(article())
    await fireEvent.click(await screen.findByTestId('preview-show-in-folder'))
    expect(window.api.app.showInFolder).toHaveBeenCalled()
  })

  it('link: opens and copies the link address', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(screen.getByText('link'))
    fireEvent.click(await screen.findByTestId('preview-open-link'))
    expect(window.api.app.openExternal).toHaveBeenCalledWith('https://example.com/page')
    fireEvent.contextMenu(screen.getByText('link'))
    fireEvent.click(await screen.findByTestId('preview-copy-link'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('https://example.com/page')
  })

  it('link: also offers copy and select-all (PLAN §4)', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(screen.getByText('link'))
    // The link variant must carry the same copy / select-all as the generic one.
    expect(await screen.findByTestId('preview-copy')).toBeInTheDocument()
    const selectAll = await screen.findByTestId('preview-select-all')
    fireEvent.click(selectAll)
    expect(window.getSelection()!.toString()).toContain('hello world')
  })

  it('code: copies the code block text', async () => {
    mount(docWithPath)
    fireEvent.contextMenu(screen.getByText('const a = 1;'))
    fireEvent.click(await screen.findByTestId('preview-copy-code'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('const a = 1;')
  })

  it('code: copies empty text when the pre has no code child', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <pre />
        </article>
      </PreviewContextMenu>,
    )
    const pre = document.querySelector('.markdown-preview pre') as HTMLElement
    fireEvent.contextMenu(pre)
    await fireEvent.click(await screen.findByTestId('preview-copy-code'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('')
  })

  it('code: copies as a fenced block, keeping the language (能力 4)', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <pre>
            <code data-lang="js">const a = 1;</code>
          </pre>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('const a = 1;'))
    await fireEvent.click(await screen.findByTestId('preview-copy-code-block'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('```js\nconst a = 1;\n```')
  })

  it('code: copies as a fenced block without a language when none was declared', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <pre>
            <code>const a = 1;</code>
          </pre>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('const a = 1;'))
    await fireEvent.click(await screen.findByTestId('preview-copy-code-block'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('```\nconst a = 1;\n```')
  })

  it('code: copies the language name only when the block declares one (能力 4)', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <pre>
            <code data-lang="ts">let a = 1;</code>
          </pre>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('let a = 1;'))
    await fireEvent.click(await screen.findByTestId('preview-copy-lang'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('ts')
  })

  it('code: does not generate the language item when there is no data-lang', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <pre>
            <code>plain</code>
          </pre>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('plain'))
    expect(await screen.findByTestId('preview-copy-code')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-copy-lang')).toBeNull()
  })

  it('table: copies as a Markdown pipe table', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <table>
            <thead>
              <tr>
                <th>a</th>
                <th>b</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>2</td>
              </tr>
            </tbody>
          </table>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('a'))
    await fireEvent.click(await screen.findByTestId('preview-copy-table'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    )
  })

  it('table: copies as TSV for spreadsheets', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <table>
            <tr>
              <td>a</td>
              <td>b</td>
            </tr>
          </table>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('a'))
    await fireEvent.click(await screen.findByTestId('preview-copy-table-tsv'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('a\tb')
  })

  it('table: an empty table copies an empty string', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <table data-testid="empty-table" />
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByTestId('empty-table'))
    await fireEvent.click(await screen.findByTestId('preview-copy-table'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('')
  })

  it('heading: copies the heading text and its anchor id', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <h1 id="section-one">Section One</h1>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('Section One'))
    await fireEvent.click(await screen.findByTestId('preview-copy-heading'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('Section One')
    fireEvent.contextMenu(screen.getByText('Section One'))
    await fireEvent.click(await screen.findByTestId('preview-copy-anchor-id'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('section-one')
  })

  it('heading: greys out the anchor-id item when the heading has no id', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <h2>No Id Here</h2>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('No Id Here'))
    expect(await screen.findByTestId('preview-copy-anchor-id')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('task: copies the task text without the checkbox', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <ul>
            <li>
              <input type="checkbox" disabled /> buy milk
            </li>
          </ul>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText(/buy milk/))
    await fireEvent.click(await screen.findByTestId('preview-copy-task-text'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('buy milk')
  })

  it('a plain list item (no checkbox) falls back to the generic menu', async () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PreviewContextMenu doc={docWithPath} previewRef={ref}>
        <article className="markdown-preview" ref={ref}>
          <ul>
            <li>plain bullet</li>
          </ul>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('plain bullet'))
    expect(await screen.findByTestId('preview-copy-path')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-copy-task-text')).toBeNull()
  })

  it('copies an empty string when there is no preview ref (PLAN §4 defensive)', async () => {
    // No previewRef: the capture handler still produces a valid menu, and copy falls back
    // to the empty string instead of throwing on a null article.
    render(
      <PreviewContextMenu doc={docWithPath}>
        <article className="markdown-preview">
          <p>hello world</p>
        </article>
      </PreviewContextMenu>,
    )
    fireEvent.contextMenu(screen.getByText('hello world'))
    await fireEvent.click(await screen.findByTestId('preview-copy'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('')
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

  it('image: copies the image to the clipboard (能力 2)', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image'))
    expect(window.api.clipboard.writeImage).toHaveBeenCalledWith('/img.png')
  })

  it('image: copies the on-disk address for a plain path (能力 3)', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-address'))
    await waitFor(() => expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/img.png'))
    // A plain (non-appdoc) path is copied as-is; resolveAppdoc is only used for appdoc:// refs.
    expect(window.api.documents.resolveAppdoc).not.toHaveBeenCalled()
  })

  it('image: shows the file in its folder (能力 3)', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/img.png'))
  })

  it('image: resolves an appdoc:// address before copying (能力 3)', async () => {
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-address'))
    await waitFor(() => {
      expect(window.api.documents.resolveAppdoc).toHaveBeenCalledWith('appdoc://d1/im.png')
      expect(window.api.clipboard.writeText).toHaveBeenCalledWith('/resolved/appdoc://d1/im.png')
    })
  })

  it('image: resolves an appdoc:// address before showing in folder (能力 3)', async () => {
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() =>
      expect(window.api.app.showInFolder).toHaveBeenCalledWith('/resolved/appdoc://d1/im.png'),
    )
  })

  it('image: saves the image as a chosen file (能力 2 另存为)', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() =>
      expect(window.api.app.copyFile).toHaveBeenCalledWith('/img.png', '/out.svg'),
    )
  })

  it('image: copies the alt text', async () => {
    mountCustom('<img src="/img.png" alt="a chart" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-alt'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('a chart')
  })

  it('image: greys out the alt-text item when the image has no alt', async () => {
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    expect(await screen.findByTestId('preview-copy-image-alt')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('image: greys out "show in folder" for a remote image', async () => {
    mountCustom('<img src="https://example.com/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    expect(await screen.findByTestId('preview-show-image-in-folder')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  // Realistic KaTeX output (`output: 'htmlAndMathml'`): the visible glyphs live in
  // `.katex-html`, while the TeX source sits in a hidden <annotation> inside
  // `.katex-mathml` so "copy formula" must drop the MathML subtree to get the text
  const katexHtml =
    '<span class="katex">' +
    '<span class="katex-mathml"><math><semantics>' +
    '<annotation encoding="application/x-tex">x^2</annotation>' +
    '</semantics></math></span>' +
    '<span class="katex-html" aria-hidden="true">x<sup>2</sup></span>' +
    '</span>'

  it('formula: copies the TeX source (能力 5 公式)', async () => {
    mountCustom(katexHtml)
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-formula-latex'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('x^2')
  })

  it('formula: copies the RENDERED text, not the TeX source', async () => {
    mountCustom(katexHtml)
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-formula'))
    // The MathML subtree carrying the source is stripped first, so only the glyphs remain.
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('x2')
  })

  it('formula: falls back to the whole katex text when KaTeX emitted no MathML', async () => {
    mountCustom(
      '<span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span>',
    )
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-formula'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('x^2')
  })

  it('formula: greys out the copy items when there is no source', async () => {
    mountCustom('<span class="katex"></span>')
    fireEvent.contextMenu(document.querySelector('.katex') as HTMLElement)
    expect(await screen.findByTestId('preview-copy-formula')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByTestId('preview-copy-formula-latex')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('mermaid: copies the diagram source (能力 5 图表)', async () => {
    mountCustom(
      '<div data-mermaid-slot="0" data-mermaid-source="graph TD;A-->B"><svg>chart</svg></div>',
    )
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-diagram-source'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('graph TD;A-->B')
  })

  it('mermaid: decodes the URI-encoded source the preview bakes onto the wrapper', async () => {
    // MarkdownPreview URI-encodes the source so it survives sanitization; the menu
    // must decode it again so the user gets the real diagram text.
    mountCustom(
      `<div data-mermaid-slot="0" data-mermaid-source="${encodeURIComponent('graph TD;A-->B')}"><svg>chart</svg></div>`,
    )
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-diagram-source'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('graph TD;A-->B')
  })

  it('mermaid: falls back to the raw attribute when the source is not decodable', async () => {
    // A stray `%` (legacy/unencoded content) must not throw while the menu opens.
    mountCustom('<div data-mermaid-slot="0" data-mermaid-source="100%"><svg>chart</svg></div>')
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-diagram-source'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('100%')
  })

  it('mermaid: copies the SVG markup (能力 5 图表)', async () => {
    mountCustom(
      '<div data-mermaid-slot="0" data-mermaid-source="graph TD;A-->B"><svg>chart</svg></div>',
    )
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-copy-svg'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('<svg>chart</svg>')
  })

  it('mermaid: saves the SVG to a chosen file (能力 5 图表另存为)', async () => {
    mountCustom(
      '<div data-mermaid-slot="0" data-mermaid-source="graph TD;A-->B"><svg>chart</svg></div>',
    )
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-save-svg-as'))
    await waitFor(() =>
      expect(window.api.export.write).toHaveBeenCalledWith('/out.svg', '<svg>chart</svg>'),
    )
  })

  it('mermaid: greys out items when there is no source / svg', async () => {
    mountCustom('<div data-mermaid-slot="0"></div>')
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    expect(await screen.findByTestId('preview-copy-diagram-source')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByTestId('preview-copy-svg')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('preview-save-svg-as')).toHaveAttribute('aria-disabled', 'true')
  })

  it('image without a src copies an empty string to the clipboard', async () => {
    mountCustom('<img />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image'))
    expect(window.api.clipboard.writeImage).toHaveBeenCalledWith('')
  })

  it('image: copies the raw appdoc:// src when resolution yields nothing', async () => {
    vi.mocked(window.api.documents.resolveAppdoc).mockResolvedValueOnce(null)
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-copy-image-address'))
    await waitFor(() =>
      expect(window.api.clipboard.writeText).toHaveBeenCalledWith('appdoc://d1/im.png'),
    )
  })

  it('image: does not open the folder when an appdoc:// src resolves to nothing', async () => {
    vi.mocked(window.api.documents.resolveAppdoc).mockResolvedValueOnce(null)
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).not.toHaveBeenCalled())
  })

  it('image: saves an image with a fallback name when the src has none', async () => {
    vi.mocked(window.api.dialog.saveFile).mockResolvedValueOnce('/out.png')
    mountCustom('<img />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() => expect(window.api.app.copyFile).toHaveBeenCalledWith('', '/out.png'))
  })

  it('image: does not save when the save dialog is cancelled', async () => {
    vi.mocked(window.api.dialog.saveFile).mockResolvedValueOnce(null)
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-save-image-as'))
    await waitFor(() => expect(window.api.app.copyFile).not.toHaveBeenCalled())
  })

  it('mermaid: does nothing when the SVG save dialog is cancelled (能力 5 图表另存为)', async () => {
    vi.mocked(window.api.dialog.saveFile).mockResolvedValueOnce(null)
    mountCustom(
      '<div data-mermaid-slot="0" data-mermaid-source="graph TD;A-->B"><svg>chart</svg></div>',
    )
    fireEvent.contextMenu(document.querySelector('[data-mermaid-slot]') as HTMLElement)
    fireEvent.click(await screen.findByTestId('preview-save-svg-as'))
    await waitFor(() => expect(window.api.export.write).not.toHaveBeenCalled())
  })

  it('image: swallows a showInFolder rejection for a plain path (能力 3)', async () => {
    vi.mocked(window.api.app.showInFolder).mockRejectedValueOnce(new Error('nope'))
    mountCustom('<img src="/img.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() => expect(window.api.app.showInFolder).toHaveBeenCalledWith('/img.png'))
  })

  it('image: swallows a showInFolder rejection for an appdoc path (能力 3)', async () => {
    vi.mocked(window.api.app.showInFolder).mockRejectedValueOnce(new Error('nope'))
    mountCustom('<img src="appdoc://d1/im.png" />')
    fireEvent.contextMenu(screen.getByRole('img'))
    fireEvent.click(await screen.findByTestId('preview-show-image-in-folder'))
    await waitFor(() =>
      expect(window.api.app.showInFolder).toHaveBeenCalledWith('/resolved/appdoc://d1/im.png'),
    )
  })
})
