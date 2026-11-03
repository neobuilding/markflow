// Scoping rule for WINDOW-level keyboard shortcuts.
//
// A window listener sees every key press in the whole app, so it has to be told when it does NOT
// own the key. Two established norms say a background shortcut must stand down while a modal
// surface is open:
//   - VS Code scopes every keybinding with `when` clauses (`!inQuickOpen`, `!inputFocus`, ...);
//     `actions.find` simply does not fire while a modal owns the keyboard.
//   - WAI-ARIA's modal dialog pattern: while a modal is open it contains focus and the background
//     content is inert.
//
// The companion rule matters just as much: a shortcut that stands down must NOT call
// preventDefault(). Swallowing a key we do not handle breaks whoever does own it — the dialog
// itself, the palette, or any future native handling. (See EditorPane's Ctrl/Cmd+F / Ctrl/Cmd+H.)
//
// Detection is deliberately NOT derived from Radix internals nor from the current focus:
//   - `data-modal-surface` is opt-in and owned by us: every Radix dialog gets it from the shared
//     `ui/dialog.tsx` wrapper, and any non-dialog overlay (e.g. the command palette) opts in
//     explicitly.
//   - `[role="dialog"]` is honoured too, so a dialog carrying the standard ARIA role is respected
//     even if it bypasses our wrapper.

export const MODAL_SURFACE_SELECTOR = '[data-modal-surface], [role="dialog"]'

// True when some modal surface is currently open and therefore owns the keyboard.
// The root is an explicit argument rather than defaulting to `document`: that keeps the function a
// plain function of its input (trivially unit-testable) and avoids a hidden default-value branch.
export function hasModalSurface(root: ParentNode): boolean {
  return root.querySelector(MODAL_SURFACE_SELECTOR) !== null
}

// True when the focused element is a text-entry field that must KEEP its own keystrokes, so a
// window-level shortcut must NOT act on the document while the user is typing there. The editor's own
// content surface (`.cm-content`) is the single exemption: editor shortcuts are MEANT to act on the
// document even when fired from within it.
//
// Use this for shortcuts that MODIFY the document (e.g. Ctrl/Cmd+B / Bold): every text field
// counts, including the find & replace widget's own inputs — they are text fields too.
export function isEditableTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  if (el.isContentEditable) return !el.classList.contains('cm-content')
  return false
}

// True when the focused element is one of the editor's find & replace widget inputs. Those live
// inside a CodeMirror panel (`.cm-panel`) and are exempt from the FIND / REPLACE shortcuts ONLY:
// Ctrl/Cmd+F / Ctrl/Cmd+H must keep working while the widget holds focus (re-opening an
// already-open panel), so EditorPane pairs this with `isEditableTarget` to stand down for them —
// but NOT for shortcuts that modify the document.
export function isFindWidgetField(el: Element | null): boolean {
  return el instanceof HTMLElement && el.closest('.cm-panel') !== null
}
