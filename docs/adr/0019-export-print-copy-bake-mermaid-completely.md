# Output artifacts get a complete mermaid bake, not the lazy preview state

Export, print and rich-text copy bake **every** mermaid diagram before they build their output.
They never read the lazily-rendered preview DOM.

## Why the preview cannot be the source

D-E① (plan-03 §4.3) moved mermaid baking out of the HTML string: the pipeline emits empty
`<div data-mermaid-slot="N">` placeholders and the preview renders each one only when it
intersects the viewport. That is what removed the ~2.5s first-paint regression (ADR 0018).

But `exportStore` is fed the sanitized HTML **string** — the same string that still holds the
empty placeholders. So when D-E① landed, every exported file, printed page and whole-article
copy silently lost **every** diagram. Verified empirically: the exported body came out as
`<div data-mermaid-slot="0" data-line="2"></div>` while the preview DOM showed the `<svg>`
at the same instant. Nothing caught it: `save-export.e2e.spec.ts` only asserted `<html lang>`
and text, and no unit test covered the export → mermaid path.

This is a special case of a general rule: **an output artifact is produced by a complete,
deterministic render, never scraped from an interactive view.** The view is allowed to be
partial (lazy, virtualized, viewport-dependent); the artifact is not. Coupling them makes the
output depend on scroll position and async timing, and it breaks outright the day the preview
gains virtualization or `content-visibility`.

## Considered Options

- **Bake all slots into the canonical string (adopted).** `bakeMermaidIntoHtml` walks the
  detached DOM, fills every placeholder, and the result goes back through `sanitizeHtml` before
  it is published to `exportStore`. Keeps the single sanitization gate and the branded
  `SanitizedHtml` contract (ADR 0002) intact, is deterministic, and is unit-testable without a
  browser. Cost: it renders diagrams the user never scrolled to — but cache-first by content
  hash means only never-before-rendered diagrams cost anything, so a re-parse of an unchanged
  document is cache hits plus one string reassembly. (Before D-E① the same cost was paid on
  **every keystroke**; now it is paid once per distinct diagram.)
- **Read the live preview DOM.** Smaller diff, and it would work today because the preview
  happens not to virtualize. Rejected: it couples output to scroll position, races the async
  bake, and bypasses the sanitization gate — the baked SVG would reach the artifact without
  passing `sanitizeHtml`, weakening ADR 0002 for a saving that disappears the moment the
  preview changes.
- **Go back to baking into the string during parse.** Rejected: that is exactly the ~2.5s
  regression D-E① removed.
- **Accept the loss and document it.** Rejected: R7 requires preview == export == print ==
  copy, and "your diagrams vanish from the export" is not an acceptable regression.

## Consequences

- `mermaidBake.ts` is the one place mermaid is rendered. The preview (lazy, DOM) and the
  output paths (complete, string) share **one** content-hash SVG cache, so a diagram the
  preview already rendered is never re-rendered for export.
- `exportStore` now holds the mermaid **sources** (`MermaidSlot[]`) next to the HTML. The
  string alone cannot be completed — the source only ever lived in the component's ref.
- The preview schedules the complete bake in the background after each parse, so the cache is
  already complete when the user hits Ctrl+C (the `copy` handler is synchronous and cannot
  await). Export and print await it explicitly at their entry points.
- A diagram that fails to render degrades to the same `mermaid-skeleton` the preview shows, in
  every output — a failure never silently deletes a block.
- One behavioral note: a diagram is now rendered **twice** if it fails (once per path), because
  a failure is not cached. That is intentional — caching a failure would make a transient error
  permanent for the session.
- Rich-text copy (R13.1) is only half-solved by this: the payload now carries the diagram, but
  Word does not render inline `<svg>` (plan-04 §2.2 F3). Making it _visible_ after paste still
  needs plan-04 D13/D14 (rasterize to a PNG `data:` URL), which remains an open decision.
