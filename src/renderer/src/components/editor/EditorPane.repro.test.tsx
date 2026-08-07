import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '../ui/tooltip'
import { useUIStore } from '../../store/ui'
import { EditorPane } from './EditorPane'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub MarkdownPreview (uses a Worker) so we only exercise the editor path.
vi.mock('../preview/MarkdownPreview', () => ({
  MarkdownPreview: () => <div data-testid="preview-stub" />,
}))

const docs: Record<
  string,
  {
    id: string
    title: string
    content: string
    filePath: string
    encoding: string
    updatedAt: number
    wordCount: number
  }
> = {
  a: {
    id: 'a',
    title: 'A',
    content: '# A content',
    filePath: '/a.md',
    encoding: 'utf-8',
    updatedAt: 1,
    wordCount: 1,
  },
  b: {
    id: 'b',
    title: 'B',
    content: '# B content',
    filePath: '/b.md',
    encoding: 'utf-8',
    updatedAt: 2,
    wordCount: 1,
  },
  c: {
    id: 'c',
    title: 'C',
    content: '# C content',
    filePath: '/c.md',
    encoding: 'utf-8',
    updatedAt: 3,
    wordCount: 1,
  },
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function ce(container: HTMLElement): string | null {
  return container.querySelector('.cm-content')?.getAttribute('contentEditable') ?? null
}

function mount(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <EditorPane />
        </TooltipProvider>
      </QueryClientProvider>,
    )
  })
  return { container, root }
}

beforeEach(() => {
  const noopUnsub = () => {}
  const api = {
    api: {
      documents: {
        get: vi.fn(async (id: string) => docs[id] ?? null),
        watch: vi.fn(async () => {}),
        unwatch: vi.fn(async () => {}),
        eol: vi.fn(async () => '\n'),
        update: vi.fn(async (id: string, u: { title?: string; content?: string }) => ({
          ...docs[id],
          ...u,
        })),
        list: vi.fn(async () => Object.values(docs)),
        create: vi.fn(async () => ({ ...docs.a, id: 'new' })),
        importMany: vi.fn(async (p: string[]) => p.map((x) => docs[x.replace('/', '')] ?? docs.a)),
        reload: vi.fn(async (id: string) => docs[id] ?? null),
        saveAs: vi.fn(async (id: string, fp: string, u: { title?: string; content?: string }) => ({
          ...docs[id],
          ...u,
          filePath: fp,
        })),
        setEncoding: vi.fn(async (id: string, e: string) => ({ ...docs[id], encoding: e })),
        delete: vi.fn(async () => {}),
        stat: vi.fn(async () => ({ exists: true, size: 1, createdAt: 1, updatedAt: 1 })),
        import: vi.fn(async (fp: string) => docs[fp.replace('/', '')] ?? docs.a),
      },
      export: {
        embedImages: vi.fn(async (h: string) => h),
        write: vi.fn(async () => {}),
        print: vi.fn(async () => {}),
      },
      search: { query: vi.fn(async () => []) },
      app: {
        getTheme: vi.fn(async () => 'system' as const),
        setTheme: vi.fn(async () => {}),
        getVersion: vi.fn(async () => '0.0.0'),
        getInitialPaths: vi.fn(async () => []),
        showInFolder: vi.fn(async () => {}),
        setLanguage: vi.fn(),
        allowQuit: vi.fn(),
      },
      files: {
        resolvePaths: vi.fn(async (p: string[]) => ({ directories: ['/d'], markdownFiles: p })),
        getPathForFile: vi.fn((f: File) => f.name),
      },
      dialog: {
        openFiles: vi.fn(async () => []),
        openFolder: vi.fn(async () => null),
        openFolderPath: vi.fn(async () => null),
        saveFile: vi.fn(async () => null),
        saveHtmlFile: vi.fn(async () => null),
      },
      window: {
        maximize: vi.fn(async () => {}),
        unmaximize: vi.fn(async () => {}),
        isMaximized: vi.fn(async () => false),
      },
      menu: { setEditable: vi.fn(), setHasDocument: vi.fn(), setPrinting: vi.fn() },
      onMenuEvent: vi.fn(() => noopUnsub),
      onFileChanged: vi.fn(() => noopUnsub),
      onOpenPaths: vi.fn(() => noopUnsub),
      onAppRequestQuit: vi.fn(() => noopUnsub),
    },
  }
  ;(window as unknown as { api: typeof api.api }).api = api.api
  useUIStore.getState().setActiveDocumentId(null)
  useUIStore.getState().setEditable(false)
  useUIStore.getState().setActiveFolder(null)
  useUIStore.getState().setViewMode('edit')
})

describe('real EditorPane — consecutive editing-mode file switches', () => {
  it('editing A, switch to B, edit B, switch to C, edit C: C must be editable', async () => {
    const { container, root } = mount()

    // Open A (read-only by default)
    await act(async () => {
      useUIStore.getState().setActiveDocumentId('a')
    })
    await flush()
    expect(ce(container)).toBe('false')

    // Edit A
    act(() => useUIStore.getState().setEditable(true))
    await flush()
    expect(ce(container)).toBe('true')

    // Switch to B (read-only again)
    await act(async () => {
      useUIStore.getState().setActiveDocumentId('b')
    })
    await flush()
    expect(ce(container)).toBe('false')

    // Edit B
    act(() => useUIStore.getState().setEditable(true))
    await flush()
    expect(ce(container)).toBe('true')

    // Switch to C (read-only again)
    await act(async () => {
      useUIStore.getState().setActiveDocumentId('c')
    })
    await flush()
    expect(ce(container)).toBe('false')

    // Edit C — this is where the 2nd switch bug recurs
    act(() => useUIStore.getState().setEditable(true))
    await flush()
    expect(ce(container)).toBe('true')

    act(() => root.unmount())
    container.remove()
  })
})
