# ADR-0033: Editor draft session isolation

- Status: Accepted (2026-11-05)
- Supersedes: the source-document-tagging approach described in `docs/agents/testing.md`
- Related: ADR-0023 (unsaved buffer registry), ADR-0024 §10 trade-off 47, ADR-0031 §5

## Context

MarkFlow is **single-active-document**: one persistent CodeMirror `EditorView`, one `localContent`
draft, one `dirty` flag, one unsaved-buffer registry. A document switch does not remount the view
(rebuilding it reintroduced the "cannot type after switching" focus problem). A 400ms debounced
`onChange` carried the editor text back into React state.

A debounce is a timer that outlives the event that scheduled it. Two independent failures followed:

1. **Content pollution**: a keystroke in A fired after the switch and wrote A's text into B's
   draft, which `isDocSwitch` then force-applied to B's `EditorView`. Ctrl+Z exposed the mixed
   buffer as "the previous file comes back".
2. **Silent data loss**: `dirty`, the unsaved-buffer registry and the text Save reads were all
   updated only by the 400ms callback. A switch or Ctrl+S inside that window saw `dirty === false`,
   so the unsaved-changes guard never fired and the edit was discarded without a prompt.

A first fix tagged each echo with its source `docId` and rejected stale echoes against the store's
current `activeDocumentId`. It worked (10/10 under a 6-worker × 10-repeat loop) but made a business
identifier part of every keystroke callback and left the debounce in charge of correctness state.

## Decision

**Isolate the editing session, commit correctness state on the keystroke frame, and reduce the
debounce to a pure UI refresh.**

1. **One editing session per document.** Each session owns an `AbortController` and its own debounce
   instance. `selectDocument` changes `activeDocumentId` synchronously; a store subscription aborts
   the old session and creates a new one **before** React commits, closing the window between
   "store switched" and "effect cleanup ran" that a pending timer could fire in. The switch effect
   repeats the rotation as a guard for prop-driven switches.
   Teardown has **two distinct paths**: a document switch drops the pending preview refresh (that
   text belongs to the document being left), whereas unmounting the editor while the SAME document
   stays open — e.g. `view-preview` hides the editor — must FLUSH it first, or the preview renders
   the pre-edit text. This distinction is locked by a unit test and a real-browser e2e case.
2. **The session owns the WRITE, not just the timer.** Aborting the debounce was not enough: the
   keystroke-frame commit (`onImmediateChange`) does not go through the debounce, so a keystroke
   landing between "the store switched" and "the view was updated" still carried the PREVIOUS
   document's text. A session therefore also records **write ownership** — the text it last wrote
   into the view — and a keystroke is committed only when it was applied to exactly that text. A
   rotated session owns nothing until the sync effect writes the new document's content, so a
   keystroke in that window is not committed at all. The check needs no identifier: it compares the
   view's own text with what the session wrote.
3. **Correctness state is committed on the keystroke frame.** `onImmediateChange(text)` writes the
   authoritative content ref, the `dirty` flag and the unsaved-buffer registry immediately. Save /
   Save As read the authoritative ref, not the throttled React state.
4. **The 400ms debounce does NOT commit authoritative content — the keystroke frame does.**
   `onImmediateChange(text)` writes the authoritative content ref, the `dirty` flag and the
   unsaved-buffer registry synchronously on the keystroke frame. The 400ms debounce then refreshes
   the preview (`localContent` → preview / word count) and re-syncs the registry, but its callback
   checks the session's `AbortSignal` before emitting. Callback signatures are plain
   `(text: string) => void`: **no document id, no identity comparison**.
5. **`EditorView` stays persistent**; a switch — and equally a reload of the SAME document from
   disk — destroys and re-creates the history state field. The undo stack is session-scoped, not
   document-scoped.

`docId` remains only as (a) the key of the unsaved-buffer registry, which the main process needs to
map unsaved text to a file, and (b) a switch signal. It is never a write target or a callback
argument.

## Consequences

- A switch or Save inside the debounce window no longer loses the edit; the unsaved-changes guard
  sees `dirty === true` on the same frame as the keystroke.
- Callbacks cannot write into a document that was switched away from: the session that owned them
  was aborted, and — for the keystroke-frame commit, which does not go through the debounce — the
  session's write ownership no longer matches the view, so the keystroke is not committed. The
  acceptance check is mechanical — `onChange` / `onImmediateChange` take a single string argument.
- **Editing before a switch is not undoable after switching back**, even when saved. This is the
  intended trade-off of a single session-scoped stack; VS Code keeps a per-resource stack instead.
  Preserving history across a wholesale buffer replacement would also leave unmappable history
  events (a second Ctrl+Z does nothing), and a per-document `EditorView` conflicts with the focus
  fix. See `CONTEXT.md` → **Undo history**.
- Registry updates now happen per keystroke, matching the original ADR-0023 design (the Search
  view already debounces `documentStateRevision` before re-querying). Only the first dirty
  keystroke flips React/store `dirty`; later ones just refresh the registry content.
- Consumers that need current text must read the authoritative ref; reading `localContent` is
  correct only for rendering the preview.

## Verification

- `--repeat-each=10 --workers=6` document-lifecycle loop: 8/10 RED before, 10/10 GREEN after.
- Unit locks for the frame commit, callback shape, session abort, write ownership (a keystroke
  after a rotation is not committed), Save reading current text, registry reporting, and switch
  reset.
- E2E locks for keystroke-frame `dirty`/registry and for the guard firing inside the debounce
  window.
