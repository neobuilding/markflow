import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { useUIStore } from '../../store/ui'
import '../../i18n'

const mockMutateAsync = vi.fn()

const docState = vi.hoisted(() => ({
  doc: {
    id: 'd1',
    filePath: '/tmp/a.md',
    wordCount: 42,
    encoding: 'GBK',
    encodingConfidence: 0.3,
  },
}))

vi.mock('../../hooks/useDocuments', () => ({
  useDocument: () => ({ data: docState.doc }),
  useSetEncoding: () => ({ mutateAsync: mockMutateAsync }),
  useCreateDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDocuments: () => ({ data: [] }),
  useFileStat: () => ({ data: undefined }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockMutateAsync.mockReset()
})

describe('StatusBar', () => {
  beforeEach(() => {
    docState.doc = {
      id: 'd1',
      filePath: '/tmp/a.md',
      wordCount: 42,
      encoding: 'GBK',
      encodingConfidence: 0.3,
    }
    useUIStore.getState().setActiveDocumentId('d1')
    useUIStore.getState().setDirty(false)
    useUIStore.getState().setSaving(false)
    useUIStore.getState().setPrinting(false)
    useUIStore.getState().setJustSaved(false)
    // StatusBar queries the line-ending via the Electron API in an effect.
    const eol = vi.fn().mockResolvedValue('\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
  })

  it('shows the word count from the active document', async () => {
    render(<StatusBar />)
    expect(await screen.findByText('42 words')).toBeInTheDocument()
  })

  it('shows the unsaved indicator when dirty', async () => {
    useUIStore.getState().setDirty(true)
    render(<StatusBar />)
    expect(await screen.findByText(/Unsaved/)).toBeInTheDocument()
  })

  it('shows the saving indicator when saving', async () => {
    useUIStore.getState().setSaving(true)
    render(<StatusBar />)
    expect(await screen.findByText(/Saving/)).toBeInTheDocument()
  })

  it('shows the printing indicator when printing', async () => {
    useUIStore.getState().setPrinting(true)
    render(<StatusBar />)
    expect(await screen.findByText(/Printing/)).toBeInTheDocument()
  })

  it('shows the saved indicator when justSaved', async () => {
    render(<StatusBar />)
    // Set justSaved after mount so the "clear on mount" effect has already run.
    act(() => useUIStore.getState().setJustSaved(true))
    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
  })

  it('shows a low-confidence encoding warning and switches encoding on pick', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    render(<StatusBar />)
    // low confidence (0.3) => ⚠ shown next to GBK
    expect(await screen.findByText('GBK ⚠')).toBeInTheDocument()
    // open the encoding dropdown
    fireEvent.click(screen.getByTitle(/encoding/i))
    const utf8 = await screen.findByText('UTF-8')
    fireEvent.click(utf8)
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ id: 'd1', encoding: 'UTF-8' }),
    )
  })

  it('hides the line-ending pill when there is no file path', async () => {
    docState.doc = { ...docState.doc, filePath: '' }
    render(<StatusBar />)
    // word count still shows, but no CRLF/LF pill
    expect(await screen.findByText('42 words')).toBeInTheDocument()
    expect(screen.queryByText('LF')).toBeNull()
    expect(screen.queryByText('CRLF')).toBeNull()
  })

  it('surfaces a set-encoding failure without crashing', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockMutateAsync.mockRejectedValueOnce(new Error('boom'))
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    const utf8 = await screen.findByText('UTF-8')
    fireEvent.click(utf8)
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('closes the encoding dropdown when clicking outside', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    expect(await screen.findByText('UTF-8')).toBeInTheDocument()
    // Click outside the encoding pill to close it.
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByText('UTF-8')).toBeNull())
  })

  it('auto-hides the saved hint after a delay', () => {
    vi.useFakeTimers()
    docState.doc = { ...docState.doc, filePath: '' }
    render(<StatusBar />)
    act(() => useUIStore.getState().setJustSaved(true))
    expect(screen.getByText(/Saved/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(screen.queryByText(/Saved/)).toBeNull()
    vi.useRealTimers()
  })

  it('does not switch encoding when the same encoding is chosen', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    // The active document is already GBK; picking GBK is a no-op.
    const gbk = await screen.findByText('GBK')
    fireEvent.click(gbk)
    await new Promise((r) => setTimeout(r, 0))
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('shows CRLF for Windows-style line endings', async () => {
    const eol = vi.fn().mockResolvedValue('\r\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    render(<StatusBar />)
    expect(await screen.findByText('CRLF')).toBeInTheDocument()
  })

  it('renders an empty word count when there is no active document', async () => {
    docState.doc = undefined as unknown as (typeof docState)['doc']
    render(<StatusBar />)
    // No active document => empty word-count slot and no encoding pill.
    expect(screen.queryByText(/words/)).toBeNull()
    expect(screen.queryByTitle(/encoding/i)).toBeNull()
  })

  it('shows a normal encoding pill without a warning when confidence is high', async () => {
    docState.doc = { ...docState.doc, encodingConfidence: 1 }
    render(<StatusBar />)
    const pill = await screen.findByTitle(/encoding/i)
    // High confidence => no ⚠ in the label and a neutral border class.
    expect(pill).toHaveTextContent('GBK')
    expect(pill).not.toHaveTextContent('⚠')
    expect(pill.className).toContain('border-[var(--color-border)]')
  })

  it('ignores a line-ending lookup failure', async () => {
    const eol = vi.fn().mockRejectedValue(new Error('nope'))
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    render(<StatusBar />)
    // A rejected eol() hits the defensive .catch: no pill, no crash.
    expect(await screen.findByText('42 words')).toBeInTheDocument()
    expect(screen.queryByText('LF')).toBeNull()
    expect(screen.queryByText('CRLF')).toBeNull()
  })

  it('skips the line-ending update when unmounted before the lookup resolves', async () => {
    let resolveEol: ((v: string) => void) | undefined
    const eol = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveEol = resolve
        }),
    )
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    const { unmount } = render(<StatusBar />)
    await screen.findByText('42 words')
    // Unmount first: the effect cleanup sets cancelled = true.
    unmount()
    await act(async () => {
      resolveEol?.('\r\n')
      await new Promise((r) => setTimeout(r, 0))
    })
    // No CRLF was ever rendered because the resolved value was discarded.
    expect(screen.queryByText('CRLF')).toBeNull()
  })

  it('keeps the dropdown open when clicking inside the encoding pill', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(window as unknown as { api: { documents: { eol: typeof eol } } }).api = {
      documents: { eol },
    }
    render(<StatusBar />)
    const pill = await screen.findByTitle(/encoding/i)
    fireEvent.click(pill)
    expect(await screen.findByText('UTF-8')).toBeInTheDocument()
    // mousedown lands inside the pill container, so the outside-click guard ignores it.
    fireEvent.mouseDown(pill)
    expect(screen.getByText('UTF-8')).toBeInTheDocument()
  })
})
