// Single XSS gate (markdown-render-v2-simple design). The gate is enforced by TYPES, not
// by a wrapper component: `sanitizeHtml()` returns the branded `SanitizedHtml`, and the
// only DOM write entry (`patchPreviewContent`) accepts nothing else — so an unsanitized
// string cannot reach `innerHTML` without a compile error (see docs/adr/0002).
import DOMPurify from 'dompurify'

// Branded type: a `string` that has ALREADY passed through `sanitizeHtml`. Because the
// brand is a private `unique symbol`, the ONLY way to produce a `SanitizedHtml` is to call
// `sanitizeHtml()` — so any value of this type is guaranteed sanitized. This makes
// "dangerouslySetInnerHTML without sanitizing" a compile error at every call site, replacing
// the old runtime-only `SafeHtml` gate with a type-level guarantee (single point of
// sanitization, exactly once — R5 / D-C).
declare const __sanitized: unique symbol
export type SanitizedHtml = string & { readonly [__sanitized]: true }

// Only allow style on code/span/math elements and all SVG-namespace elements (to
// prevent BUG-5 recurrence): DOMPurify keeps style by default, and if allowed
// everywhere a malicious embedded HTML could use style for CSS exfiltration
// (attribute selectors + background:url probes). style on all other elements
// (div/p/a/pre) is stripped
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

// DOMPurify's default URI whitelist, plus `appdoc:` — the app's own document-asset
// scheme (appdoc://<docId>/<relativePath>). It resolves only through the registered
// protocol handler in electron/main/ipc/appdoc.ts (doc lookup → containment check →
// exists), and the CSP already allows `img-src … appdoc:`; without this entry
// DOMPurify treats it as an unknown scheme and SILENTLY strips the src, so every
// relative image in the preview renders as a src-less <img> (and export loses it too).
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|appdoc):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

export function sanitizeHtml(html: string): SanitizedHtml {
  const out = DOMPurify.sanitize(html, {
    // mermaid placeholder attribute; other data-* are allowed by DOMPurify's
    // default ALLOW_DATA_ATTR.
    ADD_ATTR: ['data-mermaid-slot', 'data-mermaid-source'],
    // Default URI whitelist + the app's own appdoc: scheme (see above).
    ALLOWED_URI_REGEXP,
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
  return out as SanitizedHtml
}
