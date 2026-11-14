// Unit tests for the shared format-shortcut table and its matcher (ADR-0032).
//
// The matcher is the single gate every formatting key goes through, so these tests pin the
// EXACT match rules — a loose match would steal a key that belongs to another command
// (⌘⇧E = Files view, ⌘⇧F = search in files), which is exactly the class of bug the table was
// introduced to prevent.
import { describe, it, expect } from 'vitest'
import {
  FORMAT_SHORTCUTS,
  matchFormatShortcut,
  type FormatActionId,
  type FormatKeyEvent,
} from './format-shortcuts'

/** Build a keydown-ish object; only the fields the matcher reads. */
function key(overrides: Partial<FormatKeyEvent> & { key: string }): FormatKeyEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }
}

const MAC = true
const WIN = false

describe('format-shortcuts — the table', () => {
  it('gives every action a unique glyph', () => {
    const glyphs = Object.values(FORMAT_SHORTCUTS).map((s) => s.glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('binds the mainstream Markdown-editor keys (ADR-0032)', () => {
    // Typora / Obsidian / Bear / Zettlr: ⌘B bold, ⌘I italic, ⌘K link, ⌘1..6 headings.
    expect(FORMAT_SHORTCUTS.bold.glyph).toBe('⌘B')
    expect(FORMAT_SHORTCUTS.italic.glyph).toBe('⌘I')
    expect(FORMAT_SHORTCUTS.link.glyph).toBe('⌘K')
    expect(FORMAT_SHORTCUTS.code.glyph).toBe('⌘E')
    expect(FORMAT_SHORTCUTS.list.glyph).toBe('⌘⇧L')
    expect(FORMAT_SHORTCUTS.task.glyph).toBe('⌘⇧T')
    expect(FORMAT_SHORTCUTS.heading1.glyph).toBe('⌘1')
    expect(FORMAT_SHORTCUTS.heading6.glyph).toBe('⌘6')
  })

  it('carries the markup the toolbar buttons insert', () => {
    expect(FORMAT_SHORTCUTS.bold).toMatchObject({ before: '**', after: '**' })
    expect(FORMAT_SHORTCUTS.italic).toMatchObject({ before: '_', after: '_' })
    expect(FORMAT_SHORTCUTS.link).toMatchObject({ before: '[', after: '](url)' })
    expect(FORMAT_SHORTCUTS.code).toMatchObject({ before: '`', after: '`' })
    expect(FORMAT_SHORTCUTS.list).toMatchObject({ before: '- ', after: '' })
    expect(FORMAT_SHORTCUTS.task).toMatchObject({ before: '- [ ] ', after: '' })
  })

  it('builds the heading markup from the level', () => {
    const headings = (
      ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'] as const
    ).map((id) => FORMAT_SHORTCUTS[id].before)
    expect(headings).toEqual(['# ', '## ', '### ', '#### ', '##### ', '###### '])
  })
})

describe('format-shortcuts — matching', () => {
  it('matches every letter binding with the platform modifier', () => {
    const cases: Array<[FormatActionId, string, string, string]> = [
      ['bold', 'b', '**', '**'],
      ['italic', 'i', '_', '_'],
      ['link', 'k', '[', '](url)'],
      ['code', 'e', '`', '`'],
    ]
    for (const [id, k, before, after] of cases) {
      const match = matchFormatShortcut(key({ key: k, ctrlKey: true }), WIN)
      expect(match, `${id} on Ctrl+${k}`).toEqual({ id, before, after })
    }
  })

  it('matches the Shift bindings only with Shift held', () => {
    const list = matchFormatShortcut(key({ key: 'l', ctrlKey: true, shiftKey: true }), WIN)
    expect(list).toEqual({ id: 'list', before: '- ', after: '' })
    const task = matchFormatShortcut(key({ key: 't', ctrlKey: true, shiftKey: true }), WIN)
    expect(task).toEqual({ id: 'task', before: '- [ ] ', after: '' })

    // Without Shift they are NOT ours — and the plain letters stay unbound.
    expect(matchFormatShortcut(key({ key: 'l', ctrlKey: true }), WIN)).toBeNull()
    expect(matchFormatShortcut(key({ key: 't', ctrlKey: true }), WIN)).toBeNull()
  })

  it('does not match a Shift binding when Shift is NOT held', () => {
    // ⌘⇧L is the list; ⌘L alone must not trigger it (and vice versa).
    expect(matchFormatShortcut(key({ key: 'l', ctrlKey: true, shiftKey: true }), WIN)?.id).toBe(
      'list',
    )
    expect(matchFormatShortcut(key({ key: 'L', ctrlKey: true }), WIN)).toBeNull()
  })

  it('matches the heading levels by digit', () => {
    const h2 = matchFormatShortcut(key({ key: '2', code: 'Digit2', ctrlKey: true }), WIN)
    expect(h2).toEqual({ id: 'heading2', before: '## ', after: '' })
  })

  it('matches a heading by PHYSICAL digit position, so shifted digit rows still work', () => {
    // On AZERTY the "1" key produces `&`, so `e.key` is useless there — `e.code` is the position.
    const h1 = matchFormatShortcut(key({ key: '&', code: 'Digit1', ctrlKey: true }), WIN)
    expect(h1).toEqual({ id: 'heading1', before: '# ', after: '' })
  })

  it('needs no modifier to be absent: a bare key is never a format action', () => {
    expect(matchFormatShortcut(key({ key: 'b' }), WIN)).toBeNull()
    expect(matchFormatShortcut(key({ key: 'i' }), WIN)).toBeNull()
  })

  it('ignores the other modifier (AltGr / Alt chords)', () => {
    expect(matchFormatShortcut(key({ key: 'b', ctrlKey: true, altKey: true }), WIN)).toBeNull()
    expect(matchFormatShortcut(key({ key: 'k', metaKey: true, altKey: true }), MAC)).toBeNull()
  })

  it('resolves the modifier per platform: Ctrl off macOS, Cmd on it', () => {
    // On macOS the app resolves `metaKey`; a Ctrl-only chord is NOT the shortcut.
    expect(matchFormatShortcut(key({ key: 'b', metaKey: true }), MAC)?.id).toBe('bold')
    expect(matchFormatShortcut(key({ key: 'b', ctrlKey: true }), MAC)).toBeNull()
    // Off macOS the app resolves `ctrlKey`; a Cmd-only chord is NOT the shortcut.
    expect(matchFormatShortcut(key({ key: 'b', ctrlKey: true }), WIN)?.id).toBe('bold')
    expect(matchFormatShortcut(key({ key: 'b', metaKey: true }), WIN)).toBeNull()
  })

  it('leaves the keys of OTHER commands alone', () => {
    // ⌘⇧E = Files view, ⌘⇧F = search in files, ⌘N = new document, ⌘\ = fold the panel.
    expect(matchFormatShortcut(key({ key: 'e', ctrlKey: true, shiftKey: true }), WIN)).toBeNull()
    expect(matchFormatShortcut(key({ key: 'f', ctrlKey: true, shiftKey: true }), WIN)).toBeNull()
    expect(matchFormatShortcut(key({ key: 'n', ctrlKey: true }), WIN)).toBeNull()
    expect(matchFormatShortcut(key({ key: '\\', ctrlKey: true }), WIN)).toBeNull()
  })

  it('does not let a heading binding swallow the shifted digit row', () => {
    // ⌘⇧1 is not a heading: the digit row's shifted symbols are not ours.
    expect(
      matchFormatShortcut(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), WIN),
    ).toBeNull()
  })

  it('matches the plain (no Shift) letter bindings even when the letter is upper-case', () => {
    // CapsLock / Shift-released keys arrive as 'B'.
    expect(matchFormatShortcut(key({ key: 'B', ctrlKey: true }), WIN)?.id).toBe('bold')
  })
})
