---
status: accepted
date: 2026-09-22
deciders: plan-04 review (grill-with-docs)
---

# ADR-0020: A formula keeps MathML as its copy carrier; the bitmap is a manual action

Rich-text copy carries a formula as KaTeX's **MathML** branch, which Word and OneNote turn into a
real, editable equation. Targets that understand neither MathML nor KaTeX's CSS (有道云笔记) show the
same formula as three concatenated texts (plan 04 F23). One clipboard cannot tell the targets apart,
so instead of downgrading every copy to a picture we keep MathML by default and add an explicit
"Copy formula as image" item to the formula's context menu.

## Why MathML stays the default

A bitmap would make Word paste a picture instead of an editable equation — a downgrade for the
targets that work today, and exactly what the rejected plan-04 D17 ("rasterize every formula") would
have produced. The menu item buys the bitmap for the one target that needs it without taxing the
rest.

## Considered Options

- **MathML by default + opt-in bitmap (adopted).** Keeps "editable in Word", gives 有道云笔记 users a
  picture when they ask for one, and keeps the payload text-searchable.
- **Bitmap for every copy (plan 04 §0.5 option B).** Rejected: every Word / OneNote user loses
  editable equations to serve one target, and math disappears from the `text/plain` half entirely.
- **Strip the redundant branches (option C: drop `.katex-html` and the TeX `annotation`).** Rejected:
  it only turns three concatenated texts into one, which is still not a typeset formula, and it
  removes the TeX source that other tools consume.
- **Also offer "copy LaTeX source".** Rejected: the editor pane already copies the source with the
  `$…$` delimiters that other Markdown tools need, while `annotation` holds the delimiter-less form,
  which is strictly less useful on paste. The item would be a near-duplicate of an existing action.

## Consequences

- One object now has two carriers, deliberately: the payload's default is text (MathML); the bitmap
  is reachable only by right-clicking the formula. That asymmetry is the point — it is a choice the
  user makes per paste, not a compromise baked into every copy.
- The bitmap path is silent by design (a failure copies nothing), so it needs a real-browser e2e
  that reads the image back off the system clipboard. The whole path — KaTeX CSS + woff2 inlined as
  `data:` URLs inside an SVG `<foreignObject>`, then `<img>`/`<canvas>` — is invisible to jsdom and
  fails silently, the same failure class as the earlier `blob:` CSP bug (F14).
- The bitmap is 2×, matching the payload scale (`RASTER_SCALE`): a bare clipboard PNG carries no
  display-size metadata, so a higher multiplier would paste every formula larger than intended (and
  inflate the payload). The payload images avoid that because their `width`/`height` attributes pin
  the display size.
- Confluence / Notion are still unverified (§5.4). If either strips MathML, the manual bitmap is
  already the answer — no further design change is needed.
