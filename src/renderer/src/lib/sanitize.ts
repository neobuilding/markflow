// Single XSS gate (markdown-render-v2-simple design). Every preview injection in the
// app goes through sanitizeHtml (forced by the SafeHtml component), making it
// impossible at the code level to dangerouslySetInnerHTML an unsanitized string.
import DOMPurify from 'dompurify'

// Only allow style on code/span/math elements and all SVG-namespace elements (to
// prevent BUG-5 recurrence): DOMPurify keeps style by default, and if allowed
// everywhere a malicious embedded HTML could use style for CSS exfiltration
// (attribute selectors + background:url probes). style on all other elements
// (div/p/a/pre…) is stripped.
const STYLE_ALLOWED_TAGS = new Set(['code', 'span', 'math'])
const SVG_NS = 'http://www.w3.org/2000/svg'

DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.nodeType !== 1 /* Element */ || !node.hasAttribute('style')) return
  const tag = node.tagName.toLowerCase()
  if (STYLE_ALLOWED_TAGS.has(tag)) return
  if (node.namespaceURI === SVG_NS) return // keep style for mermaid/katex SVG
  node.removeAttribute('style')
})

// Explicitly strip all event-handler attributes (DOMPurify's FORBID_ATTR does not
// support the `on*` wildcard, so we must intercept them one by one; any attribute
// starting with "on" is dropped).
DOMPurify.addHook('uponSanitizeAttribute', (_node, attr) => {
  if (attr.attrName.toLowerCase().startsWith('on')) attr.keepAttr = false
})

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // mermaid placeholder attribute; other data-* are allowed by DOMPurify's
    // default ALLOW_DATA_ATTR.
    ADD_ATTR: ['data-mermaid-slot'],
    // Allow the SVG <use> references KaTeX / mermaid need, plus KaTeX's MathML
    // accessibility layer (annotation carries the TeX source for screen readers;
    // jsdom drops it but Chromium keeps it, so we allow it explicitly to lock the
    // behavior, matching the original rehype-sanitize schema).
    ADD_TAGS: ['use', 'annotation', 'annotation-xml'],
    // Security-critical forbids: note we deliberately do NOT forbid input (GFM task
    // list checkboxes need <input type=checkbox disabled>).
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'foreignObject', 'form', 'button'],
    FORBID_ATTR: ['action', 'formaction'],
  })
}
