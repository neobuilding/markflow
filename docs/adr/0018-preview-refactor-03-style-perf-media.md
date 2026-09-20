---
status: accepted
date: 2026-09-20
deciders: plan-03 review (grill-with-docs)
---

# ADR-0018: Preview refactor 03 — style / perf / media

## Context

`plan-03` (`docs.local/plan-preview-refactor-03-style-perf-media-2026-09.md`) consolidates four
improvements on top of `plan-01` (single sanitization gate) and `plan-02` (rich-text copy, whose
**D3 deleted the "Copy diagram source" menu** and whose **D9 flagged `data-mermaid-source` as dead code
to clean up in this phase**):

- **D-B** — unify preview styling to the same `github-markdown-css` the exporter already uses, so
  preview == export (WYSIWYG).
- **D-E①** — remove the ~2.5s first-paint mermaid-bake regression by rendering diagrams lazily in the
  DOM after the incremental patch.
- **R9** — reserve intrinsic image dimensions to kill CLS.
- **R12①** — `role="document"` + `lang` for accessibility.

A review of `plan-03` surfaced three corrections, all folded into this implementation:

1. **No `data-mermaid-source`.** `plan-03` §4.3 still referenced it "for the Copy diagram source menu",
   but that menu was removed in `plan-02` D3. The attribute is dead code (`plan-02` D9) and is removed
   from the DOM, the sanitizer allowlist (`sanitize.ts` `ADD_ATTR`), the copy-strip list
   (`previewCopy.ts` `INTERNAL_ATTRS`), and their guard tests.
2. **The single gate applies to injected SVG.** Because mermaid SVG is now written into the DOM _after_
   the patch (not baked into the pre-sanitized string), every fragment is passed through `sanitizeHtml()`
   before insertion (`plan-01` §5.2 / `plan-04` F9).
3. **Hash-cache hits fill immediately.** On re-parse the incremental patch empties every placeholder;
   cache-hit slots are refilled synchronously inside the same post-patch effect, so typing never wipes an
   already-rendered diagram, while off-screen misses stay IntersectionObserver-deferred.

## Decisions

- **D-B**: inject `github-markdown.css` (auto) + `github-markdown-dark.css` as two `<style>` elements,
  toggled by `disabled` from `useUIStore.theme`. The `@tailwindcss/typography` plugin and all `.prose`
  rules are removed; only a handful of rules are relocated to `.markdown-body`. The exporter already uses
  the same files, so preview == export. (The app ships no UI theme toggle; on a dark OS the auto sheet
  self-darkens — matching the exporter. The app chrome staying light is a pre-existing theme-sync gap,
  out of scope for `plan-03`.)
- **D-E①**: the pipeline keeps empty `<div data-mermaid-slot>` placeholders. After `patchPreviewContent`,
  an IntersectionObserver renders visible diagrams (200px `rootMargin`) into their slots; a module-level
  `Map<hash, { svg, height }>` caches by content hash. Every injected fragment is `sanitizeHtml`'d. The
  mermaid source lives only in the per-parse `res.mermaid` ref — never the DOM.
- **R9**: `documents:image-size` IPC (main) uses `image-size`'s `imageSizeFromFile` (header-only, cached
  by resolved path) and returns `{ width, height }`; the renderer writes `width`/`height` onto local
  `appdoc://` `<img>`s that lack them, before sanitize/patch, so the browser reserves space.
- **R12①**: the preview `<article>` carries `role="document"` and `lang` from
  `extractFrontmatterLang(content)`.

## Consequences

- Preview appearance now matches the exporter (links/headings use the GitHub palette; code blocks use
  `github-markdown-css` plus a preview-scoped dark token palette keyed off `data-theme` on the article).
- No first-paint mermaid regression; re-parses reuse the hash cache.
- CLS from local images is eliminated; remote images still load without reservation.
- `data-mermaid-source` is fully gone (`plan-02` D9 honored).

## References

- `plan-01` (single gate), `plan-02` (D3 / D9), `plan-03` §4.1 / §4.3 / §4.4 / §4.5, `plan-04` F9.
- See `CONTEXT.md`: `github-markdown-css`, `lazy mermaid render`, `intrinsic image dimensions`,
  `internal markers` (updated to drop `data-mermaid-source`).
