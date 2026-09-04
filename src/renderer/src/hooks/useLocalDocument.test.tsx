import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLocalDocument } from './useLocalDocument'
import { useUIStore } from '../store/ui'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.resetAllMocks()
  ;(window as unknown as { api: unknown }).api = {
    documents: {
      eol: vi.fn().mockResolvedValue('\n'),
    },
  }
})

// `strict` renders inside <StrictMode>, which remounts effects once — the only
// way the switch effect re-runs for an UNCHANGED document id, exercising its
// early-return branch (production runs under StrictMode, see main.tsx).
function renderLocalDocument(
  doc: Parameters<typeof useLocalDocument>[0],
  options: { strict?: boolean } = {},
) {
  let currentDoc = doc
  const result = { current: undefined as unknown as ReturnType<typeof useLocalDocument> }
  function Wrapper() {
    result.current = useLocalDocument(currentDoc, currentDoc?.id ?? null)
    return null
  }
  const client = new QueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const draw = () => {
    const tree = (
      <QueryClientProvider client={client}>
        <Wrapper />
      </QueryClientProvider>
    )
    act(() => {
      root.render(options.strict ? <StrictMode>{tree}</StrictMode> : tree)
    })
  }
  draw()
  // Re-render with a different doc prop on the SAME hook instance (simulates the
  // parent passing a refreshed document while staying on the same document id).
  function setDoc(next: Parameters<typeof useLocalDocument>[0]) {
    currentDoc = next
    draw()
  }
  return {
    result,
    setDoc,
    unmount: () => act(() => root.unmount()),
  }
}

const baseDoc = {
  id: 'doc-1',
  title: 'Hi',
  folderPath: '',
  filePath: '/a/hi.md',
  content: '# Hello\n',
  wordCount: 1,

  encoding: 'utf-8',
  encodingConfidence: 1,
  createdAt: 0,
  updatedAt: 0,
}

describe('useLocalDocument — toDiskFormat (line-ending restoration)', () => {
  beforeEach(() => {
    act(() => useUIStore.getState().setDirty(false))
  })

  it('converts LF to CRLF when the document is CRLF', () => {
    const { result } = renderLocalDocument({ ...baseDoc, content: '# Hello\r\nWorld\r\n' })
    const out = result.current.toDiskFormat('line1\nline2\n', '\r\n')
    expect(out).toBe('line1\r\nline2\r\n')
  })

  it('leaves LF untouched when the document is LF', () => {
    const { result } = renderLocalDocument({ ...baseDoc, content: '# Hello\nWorld\n' })
    const out = result.current.toDiskFormat('line1\nline2\n', '\n')
    expect(out).toBe('line1\nline2\n')
  })

  it('keeps LF-only input as CRLF (lone CR is preserved as-is by the simple replace)', () => {
    const { result } = renderLocalDocument({ ...baseDoc, content: '# Hello\n' })
    const out = result.current.toDiskFormat('a\rb\n', '\r\n')
    expect(out).toBe('a\rb\r\n')
  })
})

describe('useLocalDocument — dirty computation', () => {
  it('marks dirty when content changes away from the saved baseline', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.handleContentChange('# Hello\nMore text\n'))
    expect(useUIStore.getState().dirty).toBe(true)
    expect(result.current.dirty).toBe(true)
  })

  it('clears dirty when content matches the saved baseline again', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.handleContentChange('changed\n'))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.handleContentChange(baseDoc.content))
    expect(result.current.dirty).toBe(false)
  })
})

// The draft title is kept in DISPLAY form: the file name WITH its extension.
const baseDisplayTitle = 'hi.md'

describe('useLocalDocument — title draft is in display form', () => {
  it('seeds the draft from the file name (with extension), not the extension-free title', () => {
    // `title` is 'Hi' but the file is hi.md — the title bar must show `hi.md`.
    const { result, unmount } = renderLocalDocument(baseDoc)
    expect(result.current.localTitle).toBe(baseDisplayTitle)
    unmount()
  })

  it('falls back to `<title>.md` for a memory-only draft that has no file yet', () => {
    const { result, unmount } = renderLocalDocument({ ...baseDoc, filePath: '' })
    expect(result.current.localTitle).toBe('Hi.md')
    unmount()
  })

  it('shows nothing for a memory-only draft with a blank title', () => {
    const { result, unmount } = renderLocalDocument({ ...baseDoc, filePath: '', title: '' })
    expect(result.current.localTitle).toBe('')
    unmount()
  })
})

describe('useLocalDocument — handleTitleSave', () => {
  it('reverts to the saved title and clears dirty when the new title is empty', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('   '))
    act(() => result.current.handleTitleSave())
    expect(result.current.localTitle).toBe(baseDisplayTitle)
    expect(result.current.dirty).toBe(false)
  })

  it('marks dirty when the trimmed title differs from the saved title', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('Renamed'))
    act(() => result.current.handleTitleSave())
    expect(result.current.dirty).toBe(true)
  })

  it('adopts the new name immediately so the title bar shows it without a save', () => {
    // The whole point of showing the draft: Enter is enough, no Save required.
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('Renamed.md'))
    act(() => result.current.handleTitleSave())
    expect(result.current.localTitle).toBe('Renamed.md')
    expect(result.current.dirty).toBe(true)
  })

  it('re-attaches the extension when only the base name was typed', () => {
    // Typing `Renamed` for `hi.md` must yield `Renamed.md`, not a bare `Renamed`.
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('Renamed'))
    act(() => result.current.handleTitleSave())
    expect(result.current.localTitle).toBe('Renamed.md')
    expect(result.current.dirty).toBe(true)
  })

  it('falls back to .md when the current file name carries no Markdown extension', () => {
    // The open / save dialogs both offer an "All Files" filter, so a document can
    // legitimately live at `notes.txt`. Its extension is not a Markdown one, so a
    // rename cannot inherit it and must default to `.md`.
    const { result } = renderLocalDocument({
      ...baseDoc,
      filePath: '/a/notes.txt',
      title: 'notes.txt',
    })
    expect(result.current.localTitle).toBe('notes.txt')
    act(() => result.current.setLocalTitle('Renamed'))
    act(() => result.current.handleTitleSave())
    expect(result.current.localTitle).toBe('Renamed.md')
    expect(result.current.dirty).toBe(true)
  })

  it('clears dirty when the trimmed title equals the saved title', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('  hi.md  '))
    act(() => result.current.handleTitleSave())
    expect(result.current.dirty).toBe(false)
    expect(result.current.localTitle).toBe(baseDisplayTitle)
  })

  it('does not clear dirty for content edits committed together with an unchanged title', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.handleContentChange('edited\n'))
    expect(result.current.dirty).toBe(true)
    // Re-committing the same title must not wipe the unsaved content.
    act(() => result.current.handleTitleSave())
    expect(result.current.dirty).toBe(true)
  })

  it('keeps an unsaved rename across an unrelated content edit', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('Renamed.md'))
    act(() => result.current.handleTitleSave())
    expect(result.current.dirty).toBe(true)
    // Editing the content and then reverting it byte-for-byte must not drop the rename.
    act(() => result.current.handleContentChange('scratch\n'))
    act(() => result.current.handleContentChange(baseDoc.content))
    expect(result.current.dirty).toBe(true)
  })
})

describe('useLocalDocument — start/cancel title edit', () => {
  it('restores the draft as it was when the edit started', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.startTitleEdit())
    act(() => result.current.setLocalTitle('typo.md'))
    act(() => result.current.cancelTitleEdit())
    expect(result.current.localTitle).toBe(baseDisplayTitle)
    expect(result.current.editingTitle).toBe(false)
  })

  it('restores an already committed (but unsaved) rename when the next edit is cancelled', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('Renamed.md'))
    act(() => result.current.handleTitleSave())
    // Open the rename input again, type, then Escape: the committed rename survives.
    act(() => result.current.startTitleEdit())
    act(() => result.current.setLocalTitle('changed.md'))
    act(() => result.current.cancelTitleEdit())
    expect(result.current.localTitle).toBe('Renamed.md')
  })

  it('enters the edit on startTitleEdit', () => {
    const { result } = renderLocalDocument(baseDoc)
    expect(result.current.editingTitle).toBe(false)
    act(() => result.current.startTitleEdit())
    expect(result.current.editingTitle).toBe(true)
  })
})

describe('useLocalDocument — markSaved', () => {
  it('updates the saved baseline and clears the dirty flag', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.handleContentChange('changed content\n'))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.markSaved('changed content\n', 'Hi'))
    expect(result.current.dirty).toBe(false)
    // further identical edits are no longer dirty
    act(() => result.current.handleContentChange('changed content\n'))
    expect(result.current.dirty).toBe(false)
  })
})

describe('useLocalDocument — content refresh on the same doc (dirty preserved)', () => {
  it('keeps the local draft and refreshes the saved baseline when the same doc is refreshed and dirty', () => {
    // mount, then edit so we are dirty
    const h = renderLocalDocument(baseDoc)
    act(() => h.result.current.handleContentChange('my edits\n'))
    expect(h.result.current.dirty).toBe(true)
    // same doc id, new updatedAt, content differs from saved baseline -> keep draft, sync baseline
    h.setDoc({ ...baseDoc, content: 'refreshed by external save\n', updatedAt: 1 })
    expect(h.result.current.dirty).toBe(true) // still dirty (local draft differs from saved baseline)
    h.unmount()
  })

  it('clears dirty when the refreshed authoritative content matches the saved baseline exactly', () => {
    const h = renderLocalDocument(baseDoc)
    act(() => h.result.current.handleContentChange('my edits\n'))
    expect(h.result.current.dirty).toBe(true)
    // authoritative content now equals the saved baseline -> dirty is cleared
    h.setDoc({ ...baseDoc, content: baseDoc.content, updatedAt: 5 })
    expect(h.result.current.dirty).toBe(false)
    h.unmount()
  })

  it('loads the refreshed authoritative content when not dirty', () => {
    const h = renderLocalDocument(baseDoc)
    // not dirty: a refreshed content replaces the local draft
    h.setDoc({ ...baseDoc, content: 'new on-disk content\n', updatedAt: 7 })
    expect(h.result.current.localContent).toBe('new on-disk content\n')
    h.unmount()
  })

  it('infers CRLF line endings when the not-dirty refreshed content uses carriage returns', () => {
    const h = renderLocalDocument(baseDoc)
    // not dirty, same doc id, refreshed content containing CRLF -> exercises the
    // `doc.content.includes('\r\n') ? '\r\n' : '\n'` true branch in the refresh path.
    h.setDoc({ ...baseDoc, content: 'line one\r\nline two\r\n', updatedAt: 9 })
    expect(h.result.current.localContent).toBe('line one\r\nline two\r\n')
    h.unmount()
  })
})

describe('useLocalDocument — document switch (layout effect)', () => {
  it('follows the new document when the id changes', () => {
    const h = renderLocalDocument(baseDoc)
    expect(h.result.current.localContent).toBe(baseDoc.content)
    // Switch to a DIFFERENT document id: the local draft must adopt the new
    // document's content/title and drop any dirty state. This is handled by the
    // layout effect (before paint), not the refresh effect, so EditorPane never
    // paints a frame holding the previous document's text.
    act(() => h.result.current.handleContentChange('unsaved edit\n'))
    expect(h.result.current.dirty).toBe(true)
    h.setDoc({
      ...baseDoc,
      id: 'doc-2',
      title: 'Second',
      filePath: '/a/second.md',
      content: '# Second\n',
    })
    expect(h.result.current.localContent).toBe('# Second\n')
    // Display form: the new document's file name with its extension.
    expect(h.result.current.localTitle).toBe('second.md')
    expect(h.result.current.dirty).toBe(false)
    expect(useUIStore.getState().dirty).toBe(false)
    h.unmount()
  })

  it('is a no-op when the switch effect re-runs for an unchanged id (StrictMode)', () => {
    // StrictMode (enabled in main.tsx) mounts, unmounts and remounts, so the
    // switch effect runs twice with the same document id. The second pass must
    // return early instead of resetting the draft again.
    const h = renderLocalDocument(baseDoc, { strict: true })
    expect(h.result.current.localContent).toBe(baseDoc.content)
    expect(h.result.current.localTitle).toBe(baseDisplayTitle)
    expect(h.result.current.dirty).toBe(false)
    h.unmount()
  })
})

describe('useLocalDocument — manual encoding switch', () => {
  it('overwrites the local draft with the re-decoded content and clears dirty', () => {
    const h = renderLocalDocument({ ...baseDoc, encoding: 'utf-8' })
    act(() => h.result.current.handleContentChange('edits\n'))
    expect(h.result.current.dirty).toBe(true)
    // same id, encoding changed to gbk, content refreshed by the decode
    h.setDoc({ ...baseDoc, encoding: 'gbk', content: 'decoded body\n', updatedAt: 2 })
    expect(h.result.current.localContent).toBe('decoded body\n')
    expect(h.result.current.dirty).toBe(false)
    h.unmount()
  })
})

describe('useLocalDocument — eol read cleanup', () => {
  it('cancels the in-flight eol read on unmount', () => {
    const eol = vi.fn().mockReturnValue(new Promise<string>(() => {})) // never resolves
    ;(window as unknown as { api: { documents: { eol: unknown } } }).api = {
      documents: { eol },
    }
    const { unmount } = renderLocalDocument({ ...baseDoc, filePath: '/a/hi.md' })
    expect(eol).toHaveBeenCalledWith('/a/hi.md')
    unmount() // should not throw and should cancel the pending promise
  })

  it('skips the eol read when the document has no file path', () => {
    const eol = vi.fn()
    ;(window as unknown as { api: { documents: { eol: unknown } } }).api = {
      documents: { eol },
    }
    const { unmount } = renderLocalDocument({ ...baseDoc, filePath: '' })
    expect(eol).not.toHaveBeenCalled()
    unmount()
  })

  it('adopts the disk line ending once the async eol read resolves', async () => {
    // Disk is the source of truth: CRLF from disk must override the LF inferred from content.
    const eol = vi.fn().mockResolvedValue('\r\n')
    ;(window as unknown as { api: { documents: { eol: unknown } } }).api = {
      documents: { eol },
    }
    const { result, unmount } = renderLocalDocument({ ...baseDoc, content: 'a\nb\n' })
    expect(result.current.getEol()).toBe('\n') // before the async read settles
    await act(async () => {
      await Promise.resolve()
    })
    expect(eol).toHaveBeenCalledWith('/a/hi.md')
    expect(result.current.getEol()).toBe('\r\n')
    // The restored disk format must use the line ending that came from disk.
    expect(result.current.toDiskFormat('a\nb')).toBe('a\r\nb')
    unmount()
  })

  it('keeps the inferred line ending when the eol read rejects', async () => {
    // A failed disk probe must be swallowed (no unhandled rejection) and must not
    // corrupt the line ending already inferred from the document content.
    const eol = vi.fn().mockRejectedValue(new Error('EACCES'))
    ;(window as unknown as { api: { documents: { eol: unknown } } }).api = {
      documents: { eol },
    }
    const { result, unmount } = renderLocalDocument({ ...baseDoc, content: 'a\r\nb\r\n' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(eol).toHaveBeenCalledWith('/a/hi.md')
    expect(result.current.getEol()).toBe('\r\n')
    expect(result.current.toDiskFormat('a\nb')).toBe('a\r\nb')
    unmount()
  })

  it('ignores a late-resolving eol read after the effect was cancelled', async () => {
    // Guards the `if (!cancelled)` check: a promise that settles after unmount
    // must not write into the (now stale) ref.
    let settle: (v: string) => void = () => {}
    const eol = vi.fn().mockReturnValue(
      new Promise<string>((res) => {
        settle = res
      }),
    )
    ;(window as unknown as { api: { documents: { eol: unknown } } }).api = {
      documents: { eol },
    }
    const { result, unmount } = renderLocalDocument({ ...baseDoc, content: 'a\nb\n' })
    unmount()
    settle('\r\n')
    await act(async () => {
      await Promise.resolve()
    })
    // The ref was never updated, so the last known (inferred) value stands.
    expect(result.current.getEol()).toBe('\n')
  })
})

describe('useLocalDocument — null document', () => {
  it('does nothing when the document is null', () => {
    const { result, unmount } = renderLocalDocument(null)
    expect(result.current.localContent).toBe('')
    expect(result.current.dirty).toBe(false)
    unmount()
  })
})

describe('useLocalDocument — getEol', () => {
  it('returns the inferred line ending (defaults to LF when not yet CRLF)', () => {
    const { result, unmount } = renderLocalDocument(baseDoc)
    expect(result.current.getEol()).toBe('\n')
    unmount()
  })

  it('returns CRLF once the authoritative content uses carriage returns', () => {
    const { result, unmount } = renderLocalDocument({ ...baseDoc, content: 'a\r\nb\r\n' })
    expect(result.current.getEol()).toBe('\r\n')
    unmount()
  })
})
