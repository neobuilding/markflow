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
