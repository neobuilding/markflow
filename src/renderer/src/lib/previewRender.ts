// Single, type-enforced DOM write entry for the preview (R5 / D-C / D-A).
//
// Every preview update goes through `patchPreviewContent`. The `html` parameter is typed
// `SanitizedHtml`, so it is impossible (at compile time) to feed it an UNSANITIZED string —
// only the return value of `sanitizeHtml()` can satisfy the type. The function then morphs
// the existing preview DOM into the new HTML instead of destroying and rebuilding the whole
// subtree (R4 incremental update), so unchanged nodes — and the scroll position / event
// listeners they carry — survive a keystroke.
import morphdom from 'morphdom'
import type { SanitizedHtml } from './sanitize'

// Mark applied to a node that has been mutated at runtime (e.g. a broken image swapped for
// its error placeholder). When morphdom is about to discard such a node anyway it is fine;
// but we never want it to treat a runtime-injected placeholder as "still equal" and skip a
// needed update. Keeping the marker lets the equality check below stay honest.
export const DATA_BAKED = 'data-baked'

/**
 * Incrementally patch `root`'s children to match the (already sanitized) `html`.
 *
 * `childrenOnly` makes morphdom treat `root` as the container and reconcile only its
 * children, so the `<article>` wrapper itself is never replaced. `onBeforeElUpdated`
 * short-circuits the whole subtree when the old and new nodes are already byte-identical,
 * which (a) avoids needless DOM churn / flicker and (b) keeps already-rendered nodes
 * (a mermaid SVG that didn't change, a scrolled-into-view image) alive.
 */
export function patchPreviewContent(root: HTMLElement, html: SanitizedHtml): void {
  // Renderer-only module: `document` always exists here (Electron renderer / browser),
  // so a guard beyond a null-root check would be dead code. The branded `SanitizedHtml`
  // parameter is what keeps the single-sanitization guarantee (R5 / D-C).
  if (!root) return
  const next = document.createElement('div')
  next.innerHTML = html
  morphdom(root, next, {
    childrenOnly: true,
    onBeforeElUpdated: (fromEl: HTMLElement, toEl: HTMLElement): boolean => {
      // One-time-mutated nodes (e.g. image error placeholder) are runtime state that is
      // NOT reflected in the HTML string; always let morphdom reconcile them so a fresh
      // render can re-establish the correct node (e.g. the source img if the path was
      // fixed) instead of keeping a stale placeholder.
      if (fromEl.hasAttribute(DATA_BAKED)) return true
      return !fromEl.isEqualNode(toEl)
    },
  })
}
