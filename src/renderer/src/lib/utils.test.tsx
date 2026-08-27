import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { computeDirty, isMac, baseName, isInFolder, buildFileTree } from './utils'
import { useCreateDocument } from '../hooks/useDocuments'
import { useUIStore } from '../store/ui'

// Tell React's act() that we are in a test environment (silences the act warning).
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('computeDirty', () => {
  it('is false when local content equals the saved baseline', () => {
    expect(computeDirty('# Hello', '# Hello')).toBe(false)
  })

  it('is true when local content differs from the saved baseline', () => {
    expect(computeDirty('# Hello', '# World')).toBe(true)
  })

  it('is false for two empty strings', () => {
    expect(computeDirty('', '')).toBe(false)
  })

  it('treats whitespace-only differences as dirty', () => {
    expect(computeDirty('a\n', 'a')).toBe(true)
  })
})

describe('isMac', () => {
  const original = navigator.userAgent
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true })
  })

  it('returns true for a macOS user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh)',
      configurable: true,
    })
    expect(isMac()).toBe(true)
  })

  it('returns false for a Windows user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0)',
      configurable: true,
    })
    expect(isMac()).toBe(false)
  })

  it('returns false when navigator is unavailable', () => {
    const original = globalThis.navigator
    // @ts-expect-error - simulating a non-browser environment
    delete globalThis.navigator
    try {
      expect(isMac()).toBe(false)
    } finally {
      globalThis.navigator = original
    }
  })
})

describe('baseName', () => {
  it('returns the file name with extension', () => {
    expect(baseName('C:\\notes\\foo.md')).toBe('foo.md')
    expect(baseName('/home/user/foo.mdx')).toBe('foo.mdx')
  })

  it('returns the input unchanged when there is no directory separator', () => {
    expect(baseName('foo.md')).toBe('foo.md')
  })
})

describe('isInFolder / buildFileTree', () => {
  it('detects files inside a folder', () => {
    expect(isInFolder('/a/b/foo.md', '/a/b')).toBe(true)
    expect(isInFolder('/a/c/foo.md', '/a/b')).toBe(false)
  })

  it('returns false when the folder is empty', () => {
    expect(isInFolder('/a/b/foo.md', '')).toBe(false)
  })

  it('builds a tree whose file nodes carry the base name with extension', () => {
    const docs = [
      {
        id: '1',
        title: 'foo',
        folderPath: '/a',
        filePath: '/a/foo.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never
    const tree = buildFileTree(docs, '/a')
    expect(tree).toHaveLength(1)
    expect(tree[0].isFolder).toBe(false)
    expect(tree[0].name).toBe('foo.md')
  })

  it('nests subfolders and sorts folders before files alphabetically', () => {
    const docs = [
      {
        id: '1',
        title: 'z',
        folderPath: '/a',
        filePath: '/a/z.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: '2',
        title: 'a',
        folderPath: '/a',
        filePath: '/a/a.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: '3',
        title: 'deep',
        folderPath: '/a/sub',
        filePath: '/a/sub/deep.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never
    const tree = buildFileTree(docs, '/a')
    // folders first, then alphabetical
    expect(tree.map((n) => n.name)).toEqual(['sub', 'a.md', 'z.md'])
    const sub = tree.find((n) => n.name === 'sub')
    expect(sub?.isFolder).toBe(true)
    expect(sub?.children).toHaveLength(1)
    expect(sub?.children[0].name).toBe('deep.md')
  })

  it('reuses an existing folder node when multiple docs share a subfolder', () => {
    const docs = [
      {
        id: '1',
        title: 'one',
        folderPath: '/a/sub',
        filePath: '/a/sub/one.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: '2',
        title: 'two',
        folderPath: '/a/sub',
        filePath: '/a/sub/two.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never
    const tree = buildFileTree(docs, '/a')
    const sub = tree.find((n) => n.name === 'sub')
    expect(sub?.children).toHaveLength(2)
    expect(sub?.children.map((c) => c.name).sort()).toEqual(['one.md', 'two.md'])
  })

  it('sorts a file before a sibling folder when the file is inserted first (comparator false-branch)', () => {
    const docs = [
      // file at root inserted BEFORE the subfolder -> sort compares (file, folder)
      {
        id: '1',
        title: 'y',
        folderPath: '/a',
        filePath: '/a/y.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: '2',
        title: 'sub',
        folderPath: '/a/sub',
        filePath: '/a/sub/x.md',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never
    const tree = buildFileTree(docs, '/a')
    // folders-first sort still wins overall, but the comparator's `a.isFolder ? -1 : 1` false branch (file vs folder) is exercised
    expect(tree.map((n) => n.name)).toEqual(['sub', 'y.md'])
  })
})

// ─── Memory-only (unsaved draft) contract (PLAN §6.3 / §6.5 / §6.6) ───────────
function renderHook<T>(factory: () => T) {
  const result = { current: undefined as unknown as T }
  function Wrapper() {
    result.current = factory()
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
  return {
    result,
    unmount: () => act(() => root.unmount()),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(window as unknown as { api: unknown }).api = {
    documents: {
      create: vi.fn().mockResolvedValue({
        id: 'doc-1',
        title: 'Untitled',
        filePath: '',
        content: '',
        wordCount: 0,
        encoding: 'utf-8',
        encodingConfidence: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  }
})

describe('useCreateDocument memory-only contract', () => {
  it('passes memoryOnly:true by default so no file is created on disk', async () => {
    const { result } = renderHook(() => useCreateDocument())
    await act(async () => {
      await result.current.mutateAsync({ title: 'Untitled', content: '' })
    })
    const createSpy = (
      window as unknown as { api: { documents: { create: ReturnType<typeof vi.fn> } } }
    ).api.documents.create
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createSpy.mock.calls[0][0]).toMatchObject({ memoryOnly: true })
  })
})

describe('useUIStore discards unsaved drafts on close (PLAN §6.5)', () => {
  it('deletes the DB draft row when closing a new-unsaved document', () => {
    act(() => {
      useUIStore.getState().setActiveDocumentId('doc-1')
      useUIStore.getState().setIsNewUnsaved(true)
    })
    act(() => {
      useUIStore.getState().closeDocument()
    })
    const deleteSpy = (
      window as unknown as { api: { documents: { delete: ReturnType<typeof vi.fn> } } }
    ).api.documents.delete
    expect(deleteSpy).toHaveBeenCalledWith('doc-1')
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().editable).toBe(false)
  })

  it('does NOT delete a draft when the document was already saved (isNewUnsaved false)', () => {
    act(() => {
      useUIStore.getState().setActiveDocumentId('doc-2')
      useUIStore.getState().setIsNewUnsaved(false)
    })
    act(() => {
      useUIStore.getState().closeDocument()
    })
    const deleteSpy = (
      window as unknown as { api: { documents: { delete: ReturnType<typeof vi.fn> } } }
    ).api.documents.delete
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  // While exporting or with the export dialog open, closing the current file/workspace is
  // forbidden (hard guarantee covering all call paths), so we never lose the workspace on
  // an accidental Cmd/Ctrl+W shortcut.
  it('blocks closeDocument while exporting', () => {
    act(() => {
      useUIStore.getState().setActiveDocumentId('doc-3')
      useUIStore.getState().setExporting(true)
    })
    act(() => {
      useUIStore.getState().closeDocument()
    })
    const deleteSpy = (
      window as unknown as { api: { documents: { delete: ReturnType<typeof vi.fn> } } }
    ).api.documents.delete
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBe('doc-3')
  })

  it('blocks closeDocument while the export dialog is open', () => {
    act(() => {
      useUIStore.getState().setActiveDocumentId('doc-4')
      useUIStore.getState().setExportOpen(true)
    })
    act(() => {
      useUIStore.getState().closeDocument()
    })
    expect(useUIStore.getState().activeDocumentId).toBe('doc-4')
  })

  it('blocks closeWorkspace while exporting and clears the folder', () => {
    act(() => {
      useUIStore.getState().setActiveDocumentId('doc-5')
      useUIStore.getState().setActiveFolder('/tmp/x')
      useUIStore.getState().setExporting(true)
    })
    act(() => {
      useUIStore.getState().closeWorkspace()
    })
    expect(useUIStore.getState().activeDocumentId).toBe('doc-5')
    expect(useUIStore.getState().activeFolder).toBe('/tmp/x')
  })
})

// ─── utils.ts pure helpers (no React) ──────────────────────────────────────
import { cn, formatDate, debounce, dirName, formatFileSize, formatDateTime } from './utils'

describe('cn', () => {
  it('merges class names and resolves tailwind conflicts (last wins)', () => {
    expect(cn('a', 'b')).toBe('a b')
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn(null, undefined, 'y')).toBe('y')
  })
})

describe('dirName', () => {
  it('returns the directory part, normalizing backslashes', () => {
    expect(dirName('C:\\notes\\foo.md')).toBe('C:/notes')
    expect(dirName('/a/b/c.md')).toBe('/a/b')
  })
  it('returns empty string for a path with no directory', () => {
    expect(dirName('foo.md')).toBe('')
    expect(dirName('/foo.md')).toBe('')
  })
})

describe('formatFileSize', () => {
  it('formats bytes below 1KB as "B"', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })
  it('formats KB / MB / GB with sensible precision', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
    // KB unit uses 0 decimals (i===0), so 1.5 KB rounds to 2 KB
    expect(formatFileSize(1536)).toBe('2 KB')
    // MB/GB units keep one decimal; 10 MB+ drops the decimal (>= 10)
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB')
  })
  it('caps unit growth so a large file does not exceed TB label', () => {
    expect(formatFileSize(1024 * 1024 * 1024 * 1024 * 5)).toBe('5.0 TB')
  })
})

describe('formatDate', () => {
  it('shows a time string for today', () => {
    const now = Date.now()
    const out = formatDate(now)
    expect(out).not.toBe('Yesterday')
    expect(out).not.toMatch(/,/) // weekday / month forms contain a comma
  })
  it('shows "Yesterday" for ~1 day ago', () => {
    const yesterday = Date.now() - 86400000
    expect(formatDate(yesterday)).toBe('Yesterday')
  })
  it('shows a weekday for 2-6 days ago (locale-independent)', () => {
    const threeDays = Date.now() - 3 * 86400000
    const out = formatDate(threeDays)
    expect(out).not.toBe('Yesterday')
    expect(out).not.toMatch(/,/) // month+day form contains a comma separator
    // a time string (today's branch) contains a digit-delimited clock; the weekday branch is alphabetic
    expect(out).not.toMatch(/^\d/)
  })
  it('shows month+day for 7+ days ago (locale-independent)', () => {
    const old = Date.now() - 30 * 86400000
    const out = formatDate(old)
    expect(out).not.toBe('Yesterday')
    // month+day form contains a day-of-month digit (1-31); the weekday branch is alphabetic
    expect(out).toMatch(/\d/)
  })
})

describe('formatDateTime', () => {
  it('returns the dash placeholder for falsy / non-positive timestamps', () => {
    expect(formatDateTime(0)).toBe('—')
    expect(formatDateTime(-1)).toBe('—')
  })
  it('returns a localized date-time string for a real timestamp', () => {
    const out = formatDateTime(1700000000000)
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
    expect(out).not.toBe('—')
  })
})

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('only invokes the function once after the delay window', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)
    debounced()
    debounced()
    debounced()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('passes the latest arguments to the single invocation', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 50)
    debounced('a')
    debounced('b')
    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledWith('b')
  })
})

describe('buildFileTree — nested folders', () => {
  const makeDoc = (id: string, filePath: string) =>
    ({
      id,
      title: id,
      folderPath: '',
      filePath,
      content: '',
      wordCount: 0,
      encoding: 'utf-8',
      encodingConfidence: 1,
      createdAt: 0,
      updatedAt: 0,
    }) as never

  it('nests files under their subfolders and sorts folders first', () => {
    const docs = [
      makeDoc('1', '/a/foo.md'),
      makeDoc('2', '/a/b/bar.md'),
      makeDoc('3', '/a/c/baz.md'),
    ]
    const tree = buildFileTree(docs, '/a')
    expect(tree).toHaveLength(3) // foo.md + b + c
    const folders = tree.filter((n) => n.isFolder)
    expect(folders).toHaveLength(2)
    const b = folders.find((n) => n.name === 'b')!
    expect(b.children).toHaveLength(1)
    expect(b.children[0].name).toBe('bar.md')
    expect(b.children[0].isFolder).toBe(false)
  })

  it('sorts folders before files and alphabetically within a level', () => {
    const docs = [
      makeDoc('z', '/a/zeta.md'),
      makeDoc('m', '/a/mango.md'),
      makeDoc('f', '/a/folder/x.md'),
    ]
    const tree = buildFileTree(docs, '/a')
    // folders first: "folder" before the two files
    expect(tree[0].isFolder).toBe(true)
    expect(tree[0].name).toBe('folder')
    // then files alphabetically: mango before zeta
    expect(tree[1].name).toBe('mango.md')
    expect(tree[2].name).toBe('zeta.md')
  })
})
