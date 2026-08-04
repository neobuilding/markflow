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
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh)', configurable: true })
    expect(isMac()).toBe(true)
  })

  it('returns false for a Windows user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0)',
      configurable: true,
    })
    expect(isMac()).toBe(false)
  })
})

describe('baseName', () => {
  it('returns the file name with extension', () => {
    expect(baseName('C:\\notes\\foo.md')).toBe('foo.md')
    expect(baseName('/home/user/foo.mdx')).toBe('foo.mdx')
  })
})

describe('isInFolder / buildFileTree', () => {
  it('detects files inside a folder', () => {
    expect(isInFolder('/a/b/foo.md', '/a/b')).toBe(true)
    expect(isInFolder('/a/c/foo.md', '/a/b')).toBe(false)
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
        isArchived: false,
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
        isArchived: false,
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
    const createSpy = (window as unknown as { api: { documents: { create: ReturnType<typeof vi.fn> } } }).api
      .documents.create
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
    const deleteSpy = (window as unknown as { api: { documents: { delete: ReturnType<typeof vi.fn> } } }).api
      .documents.delete
    expect(deleteSpy).toHaveBeenCalledWith('doc-1')
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
  })
})
