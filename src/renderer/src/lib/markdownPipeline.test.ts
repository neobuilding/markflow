import { describe, it, expect } from 'vitest'
import { render } from './markdownPipeline'

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
})

describe('markdownPipeline — raw HTML passthrough', () => {
  it('passes raw HTML through to the sanitize step', () => {
    const { html } = render('<div onclick="x()">hi</div>\n', docId)
    expect(html).toContain('<div')
  })
})
