import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from './sanitize'

describe('sanitizeHtml — XSS stripping', () => {
  it('strips <script> tags', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('<p>ok</p>')
  })

  it('strips inline event handlers like onerror', () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
  })

  it('strips javascript: hrefs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })

  it('strips on* handlers on arbitrary elements', () => {
    const out = sanitizeHtml('<div onclick="evil()" class="keep">hi</div>')
    expect(out).not.toContain('onclick')
    expect(out).toContain('class="keep"')
  })
})

describe('sanitizeHtml — style whitelist (BUG-5)', () => {
  it('strips style on non-allowed elements (div/p/a/pre)', () => {
    const out = sanitizeHtml(
      '<div style="color:red">a</div><p style="color:blue">b</p><pre style="color:green">c</pre>'
    )
    expect(out).not.toContain('style="color:red"')
    expect(out).not.toContain('style="color:blue"')
    expect(out).not.toContain('style="color:green"')
  })

  it('retains style on <span> (allowed)', () => {
    const out = sanitizeHtml('<span style="color:red">x</span>')
    expect(out).toContain('style="color:red"')
  })

  it('retains style on <code> (allowed)', () => {
    const out = sanitizeHtml('<code style="color:red">x</code>')
    expect(out).toContain('style="color:red"')
  })

  it('retains style on SVG-namespaced elements (mermaid/katex)', () => {
    const svg =
      '<svg viewBox="0 0 10 10"><rect style="fill:red" width="10" height="10"></rect></svg>'
    const out = sanitizeHtml(svg)
    expect(out).toContain('style="fill:red"')
    expect(out).toContain('<svg')
  })
})

describe('sanitizeHtml — mermaid & data attributes', () => {
  it('retains data-mermaid-slot placeholder', () => {
    const out = sanitizeHtml('<div data-mermaid-slot="0"></div>')
    expect(out).toContain('data-mermaid-slot="0"')
  })

  it('retains mermaid SVG structure including <style> and inline styles', () => {
    const mermaid =
      '<svg id="mermaid-0" viewBox="0 0 10 10">' +
      '<style>.node{fill:red}</style>' +
      '<g style="opacity:1"><path style="stroke:blue" d="M0 0"></path></g>' +
      '<use href="#x"></use>' +
      '</svg>'
    const out = sanitizeHtml(mermaid)
    expect(out).toContain('<svg')
    expect(out).toContain('.node{fill:red}') // <style> block kept
    expect(out).toContain('style="opacity:1"')
    expect(out).toContain('style="stroke:blue"')
    expect(out).toContain('<use')
  })
})

describe('sanitizeHtml — KaTeX MathML accessibility', () => {
  it('retains <math> and <annotation> (TeX source for screen readers)', () => {
    const katex =
      '<math xmlns="http://www.w3.org/1998/Math/MathML">' +
      '<semantics><mi>E</mi>' +
      '<annotation encoding="application/x-tex">E=mc^2</annotation>' +
      '</semantics></math>'
    const out = sanitizeHtml(katex)
    expect(out).toContain('<math')
    expect(out).toContain('application/x-tex')
    expect(out).toContain('E=mc^2')
  })
})

describe('sanitizeHtml — integration with markdownPipeline', () => {
  it('produces sanitized HTML safe from injected scripts in raw HTML passthrough', async () => {
    const { render } = await import('./markdownPipeline')
    const { html } = render('<img src=x onerror="alert(1)">\n', 'doc-1')
    const out = sanitizeHtml(html)
    expect(out).not.toContain('onerror')
  })

  it('keeps katex output intact through sanitization', async () => {
    const { render } = await import('./markdownPipeline')
    const { html } = render('Inline $E=mc^2$ end\n', 'doc-1')
    const out = sanitizeHtml(html)
    expect(out).toContain('class="katex"')
  })
})
