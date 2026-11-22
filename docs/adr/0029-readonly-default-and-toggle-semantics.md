# ADR-0029: Read-only is the default — and the edit/read-only toggle states the _active_ mode

MarkFlow opens documents in **read-only** mode by default and forces read-only again whenever the
active document changes. This is a deliberate safety constraint (you cannot accidentally overwrite a
file you only meant to read). ADR-0024 §1.x recorded the default; this ADR pins down the _toggle's
visual semantics_ and fixes a latent inverted-label bug found during the Q1 review.

- **Status:** Accepted
- **Decided:** 2026-11-03
- **Supersedes:** nothing
- **Reverses:** nothing
- **Amends:** `src/renderer/src/components/editor/EditorPaneBar.tsx` (readonly action + render)
- **Related:** ADR-0024 (read-only default as a safety constraint)

---

## 1. Requirement

| #   | Requirement                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a | Default read-only and force-read-only-on-document-switch stay **exactly as they are** (behaviour unchanged except the dirty guard added in §5). |
| R-b | The toggle's _icon and pressed state_ must read intuitively: the **active / editing** mode is the highlighted one.                              |
| R-c | The accessible name (aria-label) states the **current** mode; the tooltip states the **action**.                                                |
| R-d | Fix the previously inverted label: an editable document must not be announced as "只读" by its name.                                            |

---

## 2. Evidence

- The previous code set `icon: editable ? Lock : PenLine` and `label: editable ? t('editor.readOnly') :
t('editor.edit')` — i.e. an _editable_ document rendered a **lock** and was named **"只读"**. That is
  the opposite of the intent and was the source of the user's "笔+按下 / 锁+未按" complaint.
- Industry convention (Material, Fluent, Apple HIG for toggles / segmented controls / tabs) is
  consistent: **highlight the currently-active mode**, not the passive/safe one. In the
  read-only ↔ edit pair, **edit is the active mode**; read-only is the resting/safe state. So edit
  should be the pressed/highlighted state.

---

## 3. Decision

The semantics are:

- `aria-pressed = editable` → edit mode is "pressed" (highlighted), read-only is "released" (plain).
- icon: `editable ? PenLine : Lock` → read-only shows a **dim lock**, edit shows a **highlighted pen**.
- `aria-label` = current mode (`editor.edit` / `editor.readOnly`) — **fixed** to no longer invert.
- tooltip (`hint`) = action (`editor.switchReadOnly` / `editor.switchEdit`) — unchanged.

Net effect: by default (read-only) the user sees a **dim lock, not highlighted**, which also resolves
the original "why is it always highlighted" complaint. One click → highlighted pen = editing.

Only the _presentation_ of the existing toggle changed. The default-read-only safety constraint and
the force-reset-on-switch logic are untouched.

---

## 4. Consequences

- The toggle now reads correctly to both sighted and screen-reader users; the inverted-label bug is
  closed.
- Read-only is no longer visually "loud" by default — appropriate for a safe resting state.
- Behaviour (what the button _does_) is unchanged by **this presentation fix**, so no caller or test
  of the underlying action needs to change beyond the corrected label/pressed assertions. §5 later
  added one dirty-only guard; the icon/label/pressed rules above still hold verbatim.

## 5. Amendment (2026-11-22): leaving edit mode with unsaved edits

The presentation rules above are final. One behavioural case was added afterwards: when the active
document is dirty, clicking the toggle to leave **edit → read-only** now runs the same app-modal
two-state prompt used by document switches (`app.unsavedSwitchReadOnly`, with `app.confirmDiscard`
/ `app.confirmKeep`). Choosing "keep editing" leaves the mode and the draft untouched and restores
editor focus. Choosing "discard" clears the unsaved buffer, switches to read-only, and requests the
existing `documents:reload` transaction so the editor shows the latest on-disk bytes rather than the
discarded draft. A memory-only draft has no file to reload; discarding it closes the draft.

The guard lives in the store's `toggleEditable` — the single entry the bar calls — not in the
component, so every caller gets it. This amends R-a's "behaviour unchanged" **only** for the dirty
case; the default read-only state and force-read-only-on-document-switch are untouched. Rationale:
the user is leaving the editing surface, which is a discard decision even though the document
stays open; a two-state prompt matches every other unsaved path (ADR-0009) without inventing a
third "save?" state the app has never had.

Leaving edit mode also ends the editor's **editing session** (ADR-0033 §1): `MarkdownEditor` rotates
the session when the store's `editable` flips to false. A 400ms preview echo queued from the
discarded draft is therefore dropped instead of landing after the reload, re-dirtying the freshly
loaded document and restoring the discarded text. This closed a load-dependent e2e failure in
`readonly-discard-reload.e2e.spec.ts`; the flush-on-unmount path for view changes is unchanged.
