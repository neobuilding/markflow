// The editor's formatting shortcuts — the single source of truth for BOTH the key handler and the
// glyph the toolbar advertises (ADR-0032).
//
// Why a table instead of inline `if` branches: the app had no central keybinding config, so the
// same binding was written down in several places (the window handler, the toolbar tooltip, the
// right-click menu, the global bar) and they drifted — the toolbar advertised `⌘B` while the
// right-click menu deliberately showed nothing, and the global bar kept advertising `⌘K` long
// after the key had moved. A pure table plus a pure matcher makes every binding unit-testable
// without mounting the app, and gives the UI exactly one place to read the glyph from.
//
// Ownership: these keys are RENDERER-ONLY (no native menu accelerator), the same rule ADR-0031
// established for `⌘B` — one owner per key, so nothing can double-fire.
//
// The conventions (Typora / Obsidian / Bear / Zettlr, NOT VS Code, where `⌘B` toggles the bottom
// panel) are recorded in `docs/adr/0032-format-toolbar-shortcuts-and-precedence.md`.

export type FormatActionId =
  | 'bold'
  | 'italic'
  | 'link'
  | 'code'
  | 'list'
  | 'task'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'

export interface FormatShortcut {
  /** macOS key glyphs, e.g. '⌘I' / '⌘⇧L'. Rendered per platform with `formatShortcut`. */
  readonly glyph: string
  /** The key the binding listens for: a single letter, or the digit of a heading level. */
  readonly key: string
  /** True when the binding needs Shift on top of the platform modifier. */
  readonly shift: boolean
  /** Inserted BEFORE the selection (or before the caret). */
  readonly before: string
  /** Inserted AFTER the selection. */
  readonly after: string
}

export const FORMAT_SHORTCUTS: Record<FormatActionId, FormatShortcut> = {
  bold: { glyph: '⌘B', key: 'b', shift: false, before: '**', after: '**' },
  italic: { glyph: '⌘I', key: 'i', shift: false, before: '_', after: '_' },
  link: { glyph: '⌘K', key: 'k', shift: false, before: '[', after: '](url)' },
  code: { glyph: '⌘E', key: 'e', shift: false, before: '`', after: '`' },
  list: { glyph: '⌘⇧L', key: 'l', shift: true, before: '- ', after: '' },
  task: { glyph: '⌘⇧T', key: 't', shift: true, before: '- [ ] ', after: '' },
  heading1: { glyph: '⌘1', key: '1', shift: false, before: '# ', after: '' },
  heading2: { glyph: '⌘2', key: '2', shift: false, before: '## ', after: '' },
  heading3: { glyph: '⌘3', key: '3', shift: false, before: '### ', after: '' },
  heading4: { glyph: '⌘4', key: '4', shift: false, before: '#### ', after: '' },
  heading5: { glyph: '⌘5', key: '5', shift: false, before: '##### ', after: '' },
  heading6: { glyph: '⌘6', key: '6', shift: false, before: '###### ', after: '' },
}

export interface FormatShortcutMatch {
  readonly id: FormatActionId
  readonly before: string
  readonly after: string
}

/**
 * The subset of a KeyboardEvent the matcher needs. Narrowing it to a plain shape keeps the
 * function testable with object literals instead of real DOM events.
 */
export interface FormatKeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Match a keydown against the format table.
 *
 * `isMac` decides which physical key is the modifier, exactly like the app's own handler
 * (`App.tsx`: `isMac ? e.metaKey : e.ctrlKey`), so the same binding table serves both platforms.
 *
 * Returns `null` when the key is not one of ours — including when the modifier, the Shift state
 * or Alt does not match exactly. An exact match is required so that `⌘⇧E` (Files view) and
 * `⌘⇧F` (search in files) keep their own keys and `⌘E` (code) does not steal them.
 */
export function matchFormatShortcut(e: FormatKeyEvent, isMac: boolean): FormatShortcutMatch | null {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (!mod || e.altKey) return null
  for (const id of Object.keys(FORMAT_SHORTCUTS) as FormatActionId[]) {
    const spec = FORMAT_SHORTCUTS[id]
    if (spec.shift !== e.shiftKey) continue
    if (!keyMatches(e, spec.key)) continue
    return { id, before: spec.before, after: spec.after }
  }
  return null
}

/**
 * Does the pressed key match the binding's key?
 *
 * Digits are matched by PHYSICAL position (`e.code`), so the heading levels keep working on
 * layouts whose digit row is shifted (on AZERTY, `⌘1` would otherwise be `&`). `e.key` is the
 * fallback for synthetic events that carry no `code`.
 */
function keyMatches(e: FormatKeyEvent, key: string): boolean {
  if (/^[0-9]$/.test(key)) {
    return e.code === `Digit${key}` || e.key === key
  }
  return e.key.toLowerCase() === key
}
