import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
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

function renderLocalDocument(doc: Parameters<typeof useLocalDocument>[0]) {
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
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Wrapper />
      </QueryClientProvider>,
    )
  })
  // Re-render with a different doc prop on the SAME hook instance (simulates the
  // parent passing a refreshed document while staying on the same document id).
  function setDoc(next: Parameters<typeof useLocalDocument>[0]) {
    currentDoc = next
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <Wrapper />
        </QueryClientProvider>,
      )
    })
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

describe('useLocalDocument — handleTitleSave', () => {
  it('reverts to the saved title and clears dirty when the new title is empty', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('   '))
    act(() => result.current.handleTitleSave())
    expect(result.current.localTitle).toBe(baseDoc.title)
    expect(result.current.dirty).toBe(false)
  })

  it('marks dirty when the trimmed title differs from the saved title', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('Renamed'))
    act(() => result.current.handleTitleSave())
    expect(result.current.dirty).toBe(true)
  })

  it('clears dirty when the trimmed title equals the saved title', () => {
    const { result } = renderLocalDocument(baseDoc)
    act(() => result.current.setLocalTitle('  Hi  '))
    act(() => result.current.handleTitleSave())
    expect(result.current.dirty).toBe(false)
    expect(result.current.localTitle).toBe('  Hi  ')
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
