// Route a "Select All" command to the pane the user is actually working in.
//
// WHY THIS EXISTS: the native menu used `{ role: 'selectAll' }`, whose Ctrl+A accelerator
// is intercepted in the main process and runs a NATIVE webContents-wide select-all. That
// (a) ignores CodeMirror (the editor ends up with a bogus clamped selection instead of
// "select the whole document") and (b) selects BOTH panes when the caret sits in the
// preview. The menu now sends `menu:select-all` instead, and this router picks the target:
//   - input / textarea  → native `.select()` (rename fields, search palette, find bar…)
//   - editor            → `markdown:select-all` DOM event, handled by MarkdownEditor with
//                         CodeMirror's own `selectAll` command (whole document, CM-native)
//   - preview           → `Selection.selectAllChildren(article)` (scoped to the article)
//   - none              → do nothing (focus is somewhere with no select-all meaning, e.g.
//                         the sidebar tree)
// A Radix context menu owns the focus while it is open, so a Ctrl+A arriving then is first
// used to CLOSE the menu; the routing decision is re-taken afterwards, once Radix has
// restored focus to the trigger (which is the pane the menu belonged to).
//
// The pure classifier (`resolveSelectAllTarget`) is unit-tested; the wiring is covered by
// the e2e suite (select-all-copy-fidelity.e2e.spec.ts), which drives the REAL menu item.

export type SelectAllTarget = 'input' | 'editor' | 'preview' | 'none'

// Pure classifier: given the selection's anchor element, the document's activeElement and
// the preview <article>, decide which surface the select-all belongs to. An input/textarea
// always wins (native behavior must keep working in rename/search fields); then the editor
// (selection anchored in CodeMirror, or focus anywhere in the editor pane — including its
// scroll container / Radix trigger, which is what owns focus after a menu closes); then the
// preview. Anything else (sidebar rows, toolbars, body) resolves to 'none': Ctrl+A must not
// silently yank focus into a pane the user was not working in.
export function resolveSelectAllTarget(
  anchorEl: Element | null,
  activeEl: Element | null,
  article: Element | null,
): SelectAllTarget {
  const active = activeEl as HTMLElement | null
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return 'input'
  if (
    anchorEl?.closest('.cm-content') ||
    activeEl?.closest('.cm-editor') ||
    activeEl?.closest('.editor-content')
  ) {
    return 'editor'
  }
  if (article) {
    if (anchorEl && article.contains(anchorEl)) return 'preview'
    if (activeEl && (article === activeEl || article.contains(activeEl))) return 'preview'
  }
  return 'none'
}

// Keydown interceptor for the case where Ctrl/Cmd+A reaches the RENDERER (i.e. the native
// menu accelerator did not consume it). Without this, the browser default runs: a WHOLE
// DOCUMENT select-all that sweeps in every pane and which CodeMirror then clamps into a bogus
// partial selection — the "Ctrl+A only selects the content before the cursor" symptom.
//
// It must be attached to the DOCUMENT, not to a pane: in read-only mode (files open read-only
// by default) CodeMirror's content is not contenteditable and cannot take focus, so the
// keydown's target is `body` and never bubbles through the editor container.
//
// Order of precedence: CodeMirror's own Mod-a binding and the preview `<article onKeyDown>`
// guard run first and call preventDefault(); those events are left alone (defaultPrevented).
export function createSelectAllKeydownHandler(
  win: Window = window,
  doc: Document = document,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
    if (e.key.toLowerCase() !== 'a') return
    e.preventDefault() // never let the browser's document-wide select-all run
    routeSelectAll(win, doc)
  }
}

// Dismiss an open Radix menu (context or dropdown) by re-dispatching its own dismiss key.
// Radix's DismissableLayer listens for Escape on the owner document, so a synthetic keydown
// is enough — no need to reach into React state. Returns true when a menu was open.
function closeOpenMenu(doc: Document): boolean {
  const menu = doc.querySelector('[role="menu"][data-state="open"]')
  if (!menu) return false
  doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true
}

// Wire-up entry point: read the live DOM state and execute the routed select-all.
export function routeSelectAll(
  win: Window = window,
  doc: Document = document,
  allowMenuClose = true,
): void {
  // Ctrl+A while a right-click menu is open = "dismiss the menu, then act on the pane the
  // menu belonged to". Radix restores focus to its trigger when the menu unmounts, so the
  // decision is re-taken on the next tick (`allowMenuClose: false` prevents a loop).
  if (allowMenuClose && closeOpenMenu(doc)) {
    win.setTimeout(() => routeSelectAll(win, doc, false), 0)
    return
  }

  const sel = win.getSelection()
  const anchorNode = sel?.anchorNode ?? null
  const anchorEl = anchorNode
    ? anchorNode.nodeType === 3
      ? anchorNode.parentElement
      : (anchorNode as Element)
    : null
  const activeEl = doc.activeElement instanceof Element ? doc.activeElement : null
  const article = doc.querySelector('article.markdown-preview')
  switch (resolveSelectAllTarget(anchorEl, activeEl, article)) {
    case 'input': {
      // A real HTMLInputElement/HTMLTextAreaElement always has select(); the cast is safe
      // because the branch is only reached when tagName is INPUT or TEXTAREA.
      ;(activeEl as HTMLInputElement).select()
      break
    }
    case 'preview': {
      // Scoped to the preview article — never the whole document (that would sweep the
      // editor pane into the selection too, the exact bug this router exists to fix).
      sel?.removeAllRanges()
      sel?.selectAllChildren(article!)
      break
    }
    case 'editor': {
      // MarkdownEditor owns the CodeMirror view; it listens for this event and runs the
      // CM-native `selectAll` command (a DOM select-all would leave CM's internal
      // selection desynced from the DOM).
      doc.dispatchEvent(new CustomEvent('markdown:select-all'))
      break
    }
    case 'none': {
      // Focus sits somewhere with no select-all semantics (sidebar, toolbar, body): doing
      // nothing is the correct behavior — stealing focus into a pane would be surprising.
      break
    }
  }
}
