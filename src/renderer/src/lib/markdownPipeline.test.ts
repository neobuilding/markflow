import { describe, it, expect, vi } from 'vitest'
import hljs from 'highlight.js'
import { render, rewriteImageSrc } from './markdownPipeline'

const docId = 'doc-123'

describe('markdownPipeline — GFM', () => {
  it('renders task lists with checkboxes', () => {
    const { html } = render('- [ ] a\n- [x] b\n', docId)
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
  })

  it('renders strikethrough as <s>', () => {
    const { html } = render('~~strike~~\n', docId)
    expect(html).toContain('<s>strike</s>')
  })

  it('renders tables', () => {
    const { html } = render('| a | b |\n|---|---|\n| 1 | 2 |\n', docId)
    expect(html).toContain('<table>')
  })
})

describe('markdownPipeline — math (katex)', () => {
  it('renders inline $...$', () => {
    const { html } = render('Inline $E=mc^2$ end\n', docId)
    expect(html).toContain('class="katex"')
  })

  it('renders block $$...$$ as katex-display (not inside <p>)', () => {
    const { html } = render('Para\n\n$$x=1$$\n', docId)
    expect(html).toContain('katex-display')
    expect(html.indexOf('<p>Para</p>')).toBeLessThan(html.indexOf('katex-display'))
  })

  it('does not treat currency $ as math', () => {
    const { html } = render('It costs $5 and $10 today.\n', docId)
    expect(html).not.toContain('katex')
  })

  it('does not treat adjacent-digit currency $5…$10 as math', () => {
    const { html } = render('我买了苹果花了$5又买了橘子花了$10。\n', docId)
    expect(html).not.toContain('katex')
  })

  it('leaves brackets-delimited \\(E = mc^2\\) as plain text (not connected)', () => {
    const { html } = render('\\(E = mc^2\\)\n', docId)
    expect(html).not.toContain('katex')
    expect(html).toContain('(E = mc^2)')
  })

  it('renders $5^2 = 25$ as math', () => {
    const { html } = render('Inline $5^2 = 25$ end\n', docId)
    expect(html).toContain('class="katex"')
  })

  it('renders bmatrix matrix as math', () => {
    const { html } = render('$\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}$\n', docId)
    expect(html).toContain('class="katex"')
  })

  it('does not render $x$ inside a fenced code block as math', () => {
    const { html } = render('```\n$x$\n```\n', docId)
    expect(html).not.toContain('katex')
  })

  it('does not render $x$ inside inline code as math', () => {
    const { html } = render('code `$x$` here\n', docId)
    expect(html).not.toContain('katex')
  })

  it('does not render inner-spaced $ E = mc^2 $ (leading/trailing space) as math', () => {
    const { html } = render('Inline $ E = mc^2 $ end\n', docId)
    expect(html).not.toContain('katex')
  })

  it('renders inline $$x=1$$ as display-mode math (math_inline_double)', () => {
    const { html } = render('Text $$x=1$$ more\n', docId)
    expect(html).toContain('katex-display')
  })
})

describe('markdownPipeline — mermaid slot extraction', () => {
  it('replaces ```mermaid with a placeholder and collects source', () => {
    const { html, mermaid } = render('```mermaid\nflowchart TD\nA-->B\n```\n', docId)
    expect(html).toContain('data-mermaid-slot="0"')
    expect(mermaid).toHaveLength(1)
    expect(mermaid[0].slot).toBe(0)
    expect(mermaid[0].code).toContain('flowchart TD')
    expect(typeof mermaid[0].hash).toBe('string')
    expect(mermaid[0].hash.length).toBeGreaterThan(0)
  })

  it('collects multiple mermaid blocks with distinct slots', () => {
    const src = '```mermaid\na\n```\n\n```mermaid\nb\n```\n'
    const { mermaid } = render(src, docId)
    expect(mermaid).toHaveLength(2)
    expect(mermaid[0].slot).toBe(0)
    expect(mermaid[1].slot).toBe(1)
  })
})

describe('markdownPipeline — GitHub alerts & containers', () => {
  it('renders > [!NOTE] as markdown-alert', () => {
    const { html } = render('> [!NOTE]\n> Hello\n', docId)
    expect(html).toContain('markdown-alert')
    expect(html).toContain('markdown-alert-note')
  })

  it('renders :::warning container as <div class="warning">', () => {
    const { html } = render(':::warning\nCareful\n:::\n', docId)
    expect(html).toContain('<div class="warning">')
  })
})

describe('markdownPipeline — syntax highlighting', () => {
  it('highlights a fenced code block with a known language', () => {
    const { html } = render('```js\nconst x = 1;\n```\n', docId)
    expect(html).toContain('class="hljs"')
  })

  it('auto-detects highlighting for a code block with an unknown language', () => {
    const { html } = render('```unknowndef\nconst x = 1;\n```\n', docId)
    expect(html).toContain('class="hljs"')
  })
})

describe('markdownPipeline — frontmatter', () => {
  it('strips YAML frontmatter from preview', () => {
    const { html } = render('---\ntitle: x\n---\n\n# Body\n', docId)
    expect(html).not.toContain('title: x')
    expect(html).toContain('<h1')
  })
})

describe('markdownPipeline — image rewrite (appdoc://)', () => {
  it('rewrites relative images to appdoc://<docId>/<rel>', () => {
    const { html } = render('![x](pic.png)\n', docId)
    expect(html).toContain('src="appdoc://doc-123/pic.png"')
  })

  it('leaves https: images untouched', () => {
    const { html } = render('![y](https://e.com/a.png)\n', docId)
    expect(html).toContain('src="https://e.com/a.png"')
  })

  it('leaves appdoc: images untouched', () => {
    const { html } = render('![z](appdoc://other/p.png)\n', docId)
    expect(html).toContain('src="appdoc://other/p.png"')
  })

  it('leaves data: images untouched', () => {
    const { html } = render('![d](data:image/png;base64,AAA)\n', docId)
    expect(html).toContain('src="data:image/png;base64,AAA"')
  })

  it('does NOT rewrite relative images when docId is null', () => {
    const { html } = render('![x](pic.png)\n', null)
    expect(html).toContain('src="pic.png"')
    expect(html).not.toContain('appdoc://')
  })
})

describe('markdownPipeline — remote image referrerpolicy (R4)', () => {
  it('adds referrerpolicy="no-referrer" to https images', () => {
    const { html } = render('![y](https://e.com/a.png)\n', docId)
    expect(html).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain('src="https://e.com/a.png"')
  })

  it('adds referrerpolicy="no-referrer" to http images too', () => {
    const { html } = render('![y](http://e.com/a.png)\n', docId)
    expect(html).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain('src="http://e.com/a.png"')
  })

  it('does not add referrerpolicy to a local (rewritten) image', () => {
    const { html } = render('![y](pic.png)\n', docId)
    expect(html).not.toContain('referrerpolicy')
    expect(html).toContain(`src="appdoc://${docId}/pic.png"`)
  })
})

describe('markdownPipeline — image with a missing/empty src', () => {
  it('renders an empty src unchanged and adds no referrerpolicy', () => {
    // `![x]()` yields an empty src: there is nothing to rewrite, and it is not remote,
    // so the token must be emitted untouched.
    const { html } = render('![x]()\n', docId)
    expect(html).toContain('src=""')
    expect(html).not.toContain('appdoc://')
    expect(html).not.toContain('referrerpolicy')
  })

  it('treats a null/undefined src as empty in the pure rewriter', () => {
    // Mirrors the `src ?? ''` fallbacks used by the image renderer rule when
    // attrGet('src') returns null (attribute absent).
    expect(rewriteImageSrc(null, docId)).toBe('')
    expect(rewriteImageSrc(undefined, docId)).toBe('')
    expect(rewriteImageSrc(null, null)).toBe('')
  })
})

describe('markdownPipeline — raw HTML passthrough', () => {
  it('passes raw HTML through to the sanitize step', () => {
    const { html } = render('<div onclick="x()">hi</div>\n', docId)
    expect(html).toContain('<div')
  })
})

describe('markdownPipeline — rewriteImageSrc (pure)', () => {
  it('rewrites a relative src to appdoc://<docId>/<rel>', () => {
    expect(rewriteImageSrc('pic.png', 'doc-9')).toBe('appdoc://doc-9/pic.png')
  })

  it('strips a leading ./ from the relative path', () => {
    expect(rewriteImageSrc('./sub/pic.png', 'doc-9')).toBe('appdoc://doc-9/sub/pic.png')
  })

  it('leaves a null/undefined src as an empty relative (no rewrite)', () => {
    expect(rewriteImageSrc(null, 'doc-9')).toBe('')
    expect(rewriteImageSrc(undefined, 'doc-9')).toBe('')
  })

  it('leaves https: src untouched (caller adds referrerpolicy)', () => {
    expect(rewriteImageSrc('https://e.com/a.png', 'doc-9')).toBe('https://e.com/a.png')
  })

  it('leaves data:/appdoc: src untouched', () => {
    expect(rewriteImageSrc('data:image/png;base64,AAA', 'doc-9')).toBe('data:image/png;base64,AAA')
    expect(rewriteImageSrc('appdoc://other/p.png', 'doc-9')).toBe('appdoc://other/p.png')
  })

  it('does not rewrite relative images when docId is null', () => {
    expect(rewriteImageSrc('pic.png', null)).toBe('pic.png')
  })
})

describe('markdownPipeline — highlightAuto fallback', () => {
  it('degrades to escaped plain text when highlightAuto throws', () => {
    const spy = vi.spyOn(hljs, 'highlightAuto')
    spy.mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const { html } = render('```\nconst x = 1;\n```\n', docId)
      expect(html).toContain('class="hljs"')
      expect(html).toContain('const x = 1;')
    } finally {
      spy.mockRestore()
    }
  })
})
