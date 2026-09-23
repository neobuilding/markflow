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

describe('sanitizeHtml — URI scheme whitelist (appdoc://)', () => {
  // The pipeline rewrites relative images to appdoc://<docId>/<rel>. DOMPurify's default
  // ALLOWED_URI_REGEXP does not know that scheme and SILENTLY drops the src, which left
  // every local image in the preview as a src-less <img> (and export with no image at all).
  it('keeps an appdoc:// image src (the app’s own asset scheme)', () => {
    const out = sanitizeHtml('<img src="appdoc://doc-1/img/pic.png" alt="pic">')
    expect(out).toContain('src="appdoc://doc-1/img/pic.png"')
    expect(out).toContain('alt="pic"')
  })

  it('keeps the ordinary schemes (https / http / data / relative / mailto)', () => {
    expect(sanitizeHtml('<img src="https://x/y.png">')).toContain('src="https://x/y.png"')
    expect(sanitizeHtml('<img src="http://x/y.png">')).toContain('src="http://x/y.png"')
    expect(sanitizeHtml('<img src="data:image/png;base64,AA">')).toContain(
      'src="data:image/png;base64,AA"',
    )
    expect(sanitizeHtml('<img src="pic.png">')).toContain('src="pic.png"')
    expect(sanitizeHtml('<a href="mailto:a@b.c">m</a>')).toContain('href="mailto:a@b.c"')
  })

  it('still strips javascript: and unknown custom schemes', () => {
    // Only `appdoc:` was added to the whitelist — every other exotic scheme must stay out.
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
    expect(sanitizeHtml('<img src="foo://evil/p.png">')).not.toContain('foo://')
    expect(sanitizeHtml('<img src="appdock://evil/p.png">')).not.toContain('appdock://')
  })
})

describe('sanitizeHtml — style whitelist (BUG-5)', () => {
  it('strips style on non-allowed elements (div/p/a/pre)', () => {
    const out = sanitizeHtml(
      '<div style="color:red">a</div><p style="color:blue">b</p><pre style="color:green">c</pre>',
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

  // NOTE: `data-mermaid-source` was removed in plan-02 D3/D9 (the "Copy diagram source"
  // menu item no longer exists), so there is no longer a diagram-source attribute to
  // retain or strip. The placeholder keeps only `data-mermaid-slot` (tested below).

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

describe('sanitizeHtml — R6 hardening (FORBID_TAGS / on* hook)', () => {
  it('strips <foreignObject> (SVG-embedded HTML XSS surface)', () => {
    const out = sanitizeHtml(
      '<svg><foreignObject><div onload="evil()">x</div></foreignObject></svg>',
    )
    expect(out).not.toContain('foreignObject')
  })
  it('strips <script> inside SVG', () => {
    const out = sanitizeHtml('<svg><script>alert(1)</script></svg>')
    expect(out).not.toContain('<script')
  })
  it('strips <form> and <button>', () => {
    const out = sanitizeHtml('<form action="/x"><button>go</button></form>')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<button')
  })
  it('strips on* attribute via uponSanitizeAttribute hook', () => {
    const out = sanitizeHtml('<div onclick="evil()" onmouseover="x()">y</div>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
  })
  it('retains GFM task-list checkbox <input type="checkbox">', () => {
    const out = sanitizeHtml('<li><input type="checkbox" disabled> task</li>')
    expect(out).toContain('type="checkbox"')
  })
  it('retains SVG <style> (mermaid/katex)', () => {
    const out = sanitizeHtml('<svg><style>.a{fill:red}</style></svg>')
    expect(out).toContain('.a{fill:red}')
  })
})

describe('sanitizeHtml — integration with markdownPipeline', () => {
  it('produces sanitized HTML safe from injected scripts in raw HTML passthrough', async () => {
    const { render } = await import('./markdownPipeline')
    const { html } = render('<img src=x onerror="alert(1)">\n', 'doc-1')
    const out = sanitizeHtml(html)
    expect(out).not.toContain('onerror')
  }, 20000)

  it('keeps katex output intact through sanitization', async () => {
    const { render } = await import('./markdownPipeline')
    const { html } = render('Inline $E=mc^2$ end\n', 'doc-1')
    const out = sanitizeHtml(html)
    expect(out).toContain('class="katex"')
  })

  it('strips texmath <eq>/<eqn> wrappers but keeps inner katex', async () => {
    const { render } = await import('./markdownPipeline')
    const { html } = render('Inline $E=mc^2$ end\n\n$$\nx=1\n$$\n', 'doc-1')
    // texmath default output wraps inline in <eq> and block in <section><eqn>.
    expect(html).toContain('<eq')
    const out = sanitizeHtml(html)
    // non-standard <eq>/<eqn> tags are dropped by DOMPurify ...
    expect(out).not.toContain('<eq')
    // ... while the inner KaTeX rendering is retained.
    expect(out).toContain('class="katex"')
    expect(out).toContain('katex-display')
  })
})

describe('sanitizeHtml — SanitizedHtml brand (R5 / D-C)', () => {
  it('returns a string carrying the sanitized (XSS-stripped) content', () => {
    const clean = sanitizeHtml('<p>ok</p><script>alert(1)</script>')
    expect(typeof clean).toBe('string')
    expect(clean).toContain('<p>ok</p>')
    expect(clean).not.toContain('<script')
  })

  it('is assignable to a plain string (SanitizedHtml is a string subtype)', () => {
    const clean = sanitizeHtml('<p>ok</p>')
    const asString: string = clean
    expect(asString).toContain('<p>ok</p>')
  })

  it('cannot be constructed from an arbitrary string at the type level', () => {
    // Runtime counterpart of the compile-time guarantee: only sanitizeHtml may mint a
    // SanitizedHtml. We assert the value is hardening-applied, so the single write entry
    // (patchPreviewContent) can trust it blindly.
    const raw = '<img src=x onerror="evil()">'
    const clean = sanitizeHtml(raw)
    expect(clean).not.toContain('onerror')
    expect(clean).toBe(sanitizeHtml(raw))
  })
})

describe('sanitizeHtml — R6 data-line survives sanitization', () => {
  it('keeps the data-line source-mapping attribute on blocks (data-* allowed by default)', () => {
    // R6 is only real if DOMPurify lets `data-line` through: the preview DOM, the export HTML
    // and the stage-2 rich-text-copy all read the attribute off the SANITIZED string.
    const out = sanitizeHtml(
      '<h1 data-line="0">T</h1><p data-line="2">b</p><pre data-line="4"><code>x</code></pre>',
    )
    expect(out).toContain('data-line="0"')
    expect(out).toContain('data-line="2"')
    expect(out).toContain('data-line="4"')
  })
})
