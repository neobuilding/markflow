# ADR-0002: Single sanitization gate

- **Status:** Accepted

## Context

The Markdown rendering path (parser + HTML output) is the security-critical surface of MarkFlow: it turns
untrusted user/content Markdown into HTML rendered in a web view. If sanitization happens in more than one
place, one of those places will eventually be bypassed, and the XSS surface becomes impossible to audit.

## Decision

Enforce **exactly one** sanitization boundary. Rendered Markdown HTML must pass through
`sanitizeHtml` (DOMPurify) and no other code path may emit raw, unsanitized HTML into the
preview.

The guarantee is enforced by the **type system** rather than by a wrapper component (the old
`SafeHtml` component was removed in the Plan-01 render-pipeline refactor): `sanitizeHtml()` returns
the branded type `SanitizedHtml`, whose brand is a private `unique symbol`, so the only way to
produce one is to call `sanitizeHtml()`; and the single DOM write entry
`patchPreviewContent(root, html: SanitizedHtml)` in `previewRender.ts` accepts nothing else. Feeding
an unsanitized string into the preview is therefore a compile error, not a runtime convention.

Concrete rules:

- The gate lives in `src/renderer/src/lib/sanitize.ts`; `previewRender.ts#patchPreviewContent` is the
  only DOM write entry, called solely from `MarkdownPreview.tsx`.
- The same `SanitizedHtml` value is reused for the preview DOM **and** the export cache
  (`exportStore.ts`), so preview and export cannot drift apart.
- `markdownPipeline.test.ts` and `sanitize.test.ts` lock the behavior (script/onerror/`javascript:`
  stripping, `style` whitelist, Mermaid SVG / `data-mermaid-slot` / KaTeX `<math>` retention,
  `appdoc://` image src retention).
- Any new rendering feature (new container, new embed, new code-block handler) must route its HTML through
  the same gate. "Quick local `dangerouslySetInnerHTML`" is not allowed.

## Consequences

- **Positive:** one auditable XSS control point; easy to reason about and to test.
- **Positive:** CodeQL + Secretlint + the unit gate together make the rendering path the best-protected
  part of the app.
- **Negative:** every new HTML-producing feature must conform to DOMPurify's model; exotic markup that
  DOMPurify drops needs an explicit, reviewed exception rather than an end-run around the gate.
