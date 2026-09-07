import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { useUIStore } from '../../store/ui'
import '../../i18n'

const mockMutateAsync = vi.fn()
const mockSetEol = vi.fn()
const mockReload = vi.fn()
const mockDetect = vi.fn()
const mockConfirm = vi.fn()
const mockWriteText = vi.fn()

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
  useSetEol: () => ({ mutateAsync: mockSetEol }),
  useReloadDocument: () => ({ mutateAsync: mockReload }),
  useCreateDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDocuments: () => ({ data: [] }),
  useFileStat: () => ({ data: undefined }),
}))

// Every test needs the full preload surface: documents (eol / detect / setEol / reload),
// the app-modal confirm (EOL switching now confirms first) and the clipboard
// (the status-bar menus copy otherwise unselectable text).
function installApi(eolImpl: () => Promise<string> = async () => '\n') {
  ;(window as unknown as { api: unknown }).api = {
    documents: {
      eol: eolImpl,
      detectEncoding: mockDetect,
      setEol: mockSetEol,
      reload: mockReload,
    },
    dialog: { confirm: mockConfirm },
    clipboard: { writeText: mockWriteText },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockMutateAsync.mockReset()
  mockSetEol.mockReset()
  mockReload.mockReset()
  mockDetect.mockReset()
  mockConfirm.mockReset()
  mockWriteText.mockReset()
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
    useUIStore.getState().setEditable(true)
    useUIStore.getState().requestFileAction(null)
    mockConfirm.mockResolvedValue(true)
    mockWriteText.mockResolvedValue(undefined)
    // StatusBar queries the line-ending via the Electron API in an effect.
    installApi()
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
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    // The active document is already GBK; picking GBK is a no-op.
    const gbk = await screen.findByText('GBK')
    fireEvent.click(gbk)
    await new Promise((r) => setTimeout(r, 0))
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('shows CRLF for Windows-style line endings', async () => {
    installApi(async () => '\r\n')
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
    installApi(async () => {
      throw new Error('nope')
    })
    render(<StatusBar />)
    // A rejected eol() hits the defensive .catch: no pill, no crash.
    expect(await screen.findByText('42 words')).toBeInTheDocument()
    expect(screen.queryByText('LF')).toBeNull()
    expect(screen.queryByText('CRLF')).toBeNull()
  })

  it('skips the line-ending update when unmounted before the lookup resolves', async () => {
    let resolveEol: ((v: string) => void) | undefined
    installApi(
      () =>
        new Promise<string>((resolve) => {
          resolveEol = resolve
        }),
    )
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
    render(<StatusBar />)
    const pill = await screen.findByTitle(/encoding/i)
    fireEvent.click(pill)
    expect(await screen.findByText('UTF-8')).toBeInTheDocument()
    // mousedown lands inside the pill container, so the outside-click guard ignores it.
    fireEvent.mouseDown(pill)
    expect(screen.getByText('UTF-8')).toBeInTheDocument()
  })

  it('switches the line ending to CRLF on disk and reloads (能力 6)', async () => {
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    fireEvent.click(await screen.findByText(/Switch to CRLF|切换为 CRLF/i))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    await waitFor(() =>
      expect(mockSetEol).toHaveBeenCalledWith({ filePath: '/tmp/a.md', eol: '\r\n' }),
    )
    expect(mockReload).toHaveBeenCalledWith('d1')
  })

  it('does not switch line endings when the confirm is cancelled', async () => {
    mockConfirm.mockResolvedValueOnce(false)
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    fireEvent.click(await screen.findByText(/Switch to CRLF|切换为 CRLF/i))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(mockSetEol).not.toHaveBeenCalled()
    expect(mockReload).not.toHaveBeenCalled()
  })

  it('does not switch when the target line ending is already active', async () => {
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    const lfItem = await screen.findByText(/Switch to LF|切换为 LF/i)
    expect(lfItem).toBeDisabled()
    fireEvent.click(lfItem)
    expect(mockSetEol).not.toHaveBeenCalled()
  })

  it('re-detects encoding from disk and applies it (能力 11)', async () => {
    mockDetect.mockResolvedValue({ enc: 'GB2312', confidence: 0.8 })
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    fireEvent.click(await screen.findByText(/Re-detect encoding|重新检测编码/))
    await waitFor(() => expect(mockDetect).toHaveBeenCalledWith('/tmp/a.md'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ id: 'd1', encoding: 'GB2312' }),
    )
  })

  it('shows the detecting label while re-detection is in flight (能力 11)', async () => {
    let resolveDetect!: (v: { enc: string; confidence: number }) => void
    mockDetect.mockImplementationOnce(
      () =>
        new Promise<{ enc: string; confidence: number }>((res) => {
          resolveDetect = res
        }),
    )
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    fireEvent.click(await screen.findByText(/Re-detect encoding|重新检测编码/))
    // handleRedetect closes the menu but keeps redetecting=true; re-open to reveal the label.
    fireEvent.click(await screen.findByTitle(/encoding/i))
    // While detection is pending, redetecting=true toggles the label and disables the button.
    expect(await screen.findByText(/Detecting/)).toBeInTheDocument()
    expect(screen.getByText(/Detecting/)).toBeDisabled()
    await act(async () => {
      resolveDetect({ enc: 'utf-8', confidence: 1 })
    })
    await waitFor(() => expect(screen.queryByText(/Detecting/)).toBeNull())
  })

  it('disables re-detect encoding for a draft with no file path', async () => {
    docState.doc = { ...docState.doc, filePath: '' }
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    expect(await screen.findByText(/Re-detect encoding|重新检测编码/)).toBeDisabled()
  })

  it('logs a failure when the line-ending switch rejects (能力 6)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSetEol.mockRejectedValueOnce(new Error('boom'))
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    fireEvent.click(await screen.findByText(/Switch to CRLF|切换为 CRLF/i))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('logs a failure when re-detect encoding rejects (能力 11)', async () => {
    mockDetect.mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    fireEvent.click(await screen.findByText(/Re-detect encoding|重新检测编码/))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('switches the line ending to LF on disk and reloads (能力 6)', async () => {
    installApi(async () => '\r\n')
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('CRLF'))
    fireEvent.click(await screen.findByText(/Switch to LF|切换为 LF/i))
    await waitFor(() =>
      expect(mockSetEol).toHaveBeenCalledWith({ filePath: '/tmp/a.md', eol: '\n' }),
    )
    expect(mockReload).toHaveBeenCalledWith('d1')
  })

  it('closes the line-ending dropdown when clicking outside', async () => {
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    expect(await screen.findByText(/Switch to CRLF|切换为 CRLF/i)).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByText(/Switch to CRLF|切换为 CRLF/i)).toBeNull())
  })

  it('keeps the line-ending dropdown open when clicking inside the pill', async () => {
    render(<StatusBar />)
    const pill = await screen.findByText('LF')
    fireEvent.click(pill)
    expect(await screen.findByText(/Switch to CRLF|切换为 CRLF/i)).toBeInTheDocument()
    fireEvent.mouseDown(pill)
    expect(screen.getByText(/Switch to CRLF|切换为 CRLF/i)).toBeInTheDocument()
  })
})

// ── : right-click menus on the status-bar segments ──────────────────
// The whole status bar is `user-select: none`, so these menus are the only way
// to get the word count / encoding / line ending out of the bar.
describe('StatusBar — context menus (PLAN §8)', () => {
  beforeEach(() => {
    docState.doc = {
      id: 'd1',
      filePath: '/tmp/a.md',
      wordCount: 42,
      encoding: 'GBK',
      encodingConfidence: 1,
    }
    useUIStore.getState().setActiveDocumentId('d1')
    useUIStore.getState().setDirty(false)
    useUIStore.getState().setSaving(false)
    useUIStore.getState().setPrinting(false)
    useUIStore.getState().setJustSaved(false)
    useUIStore.getState().setEditable(true)
    useUIStore.getState().requestFileAction(null)
    mockConfirm.mockResolvedValue(true)
    mockWriteText.mockResolvedValue(undefined)
    installApi()
  })

  it('copies the word count, the file path and the file name', async () => {
    render(<StatusBar />)
    const counter = await screen.findByTestId('status-word-count')

    fireEvent.contextMenu(counter)
    fireEvent.click(await screen.findByTestId('sb-copy-word-count'))
    expect(mockWriteText).toHaveBeenLastCalledWith('42')

    fireEvent.contextMenu(counter)
    fireEvent.click(await screen.findByTestId('sb-copy-path'))
    expect(mockWriteText).toHaveBeenLastCalledWith('/tmp/a.md')

    fireEvent.contextMenu(counter)
    fireEvent.click(await screen.findByTestId('sb-copy-filename'))
    expect(mockWriteText).toHaveBeenLastCalledWith('a.md')
  })

  it('greys the word-count menu items when there is no document', async () => {
    docState.doc = undefined as unknown as (typeof docState)['doc']
    installApi(async () => '')
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByTestId('status-word-count'))
    expect(await screen.findByTestId('sb-copy-word-count')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('sb-copy-path')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('sb-copy-filename')).toHaveAttribute('aria-disabled', 'true')
  })

  it('ticks the active encoding and switches from the flat encoding menu', async () => {
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByTitle(/encoding/i))
    // The nine encodings are flat ( 4) and the active one carries a tick
    expect(await screen.findByTestId('sb-encoding-GBK')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('sb-encoding-UTF-8')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByTestId('sb-encoding-UTF-8'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ id: 'd1', encoding: 'UTF-8' }),
    )
  })

  it('picking the already-active encoding from the menu is a no-op', async () => {
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByTitle(/encoding/i))
    fireEvent.click(await screen.findByTestId('sb-encoding-GBK'))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('copies the encoding name and re-detects from the menu', async () => {
    mockDetect.mockResolvedValue({ enc: 'utf-8', confidence: 1 })
    render(<StatusBar />)
    const pill = await screen.findByTitle(/encoding/i)

    fireEvent.contextMenu(pill)
    fireEvent.click(await screen.findByTestId('sb-copy-encoding'))
    expect(mockWriteText).toHaveBeenLastCalledWith('GBK')

    fireEvent.contextMenu(pill)
    fireEvent.click(await screen.findByTestId('sb-redetect-encoding'))
    await waitFor(() => expect(mockDetect).toHaveBeenCalledWith('/tmp/a.md'))
  })

  it('switches the line ending from the context menu after confirming', async () => {
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByText('LF'))
    fireEvent.click(await screen.findByTestId('sb-switch-crlf'))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    await waitFor(() =>
      expect(mockSetEol).toHaveBeenCalledWith({ filePath: '/tmp/a.md', eol: '\r\n' }),
    )
    expect(mockReload).toHaveBeenCalledWith('d1')
  })

  it('cancels the line-ending switch from the context menu', async () => {
    mockConfirm.mockResolvedValueOnce(false)
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByText('LF'))
    fireEvent.click(await screen.findByTestId('sb-switch-crlf'))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(mockSetEol).not.toHaveBeenCalled()
  })

  it('greys the already-active line ending and copies the line-ending name', async () => {
    render(<StatusBar />)
    const pill = await screen.findByText('LF')
    fireEvent.contextMenu(pill)
    expect(await screen.findByTestId('sb-switch-lf')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(await screen.findByTestId('sb-copy-line-ending'))
    expect(mockWriteText).toHaveBeenLastCalledWith('LF')
  })

  it('requests save / save-as / reload through the store bridge', async () => {
    useUIStore.getState().setDirty(true)
    render(<StatusBar />)
    const region = await screen.findByTestId('status-save-region')

    fireEvent.contextMenu(region)
    fireEvent.click(await screen.findByTestId('sb-save'))
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'save' })

    useUIStore.getState().requestFileAction(null)
    fireEvent.contextMenu(region)
    fireEvent.click(await screen.findByTestId('sb-save-as'))
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'saveAs' })

    useUIStore.getState().requestFileAction(null)
    fireEvent.contextMenu(region)
    fireEvent.click(await screen.findByTestId('sb-reload'))
    expect(useUIStore.getState().pendingFileAction).toEqual({ type: 'reload' })
  })

  it('greys save in read-only mode with a hint and keeps reload available', async () => {
    useUIStore.getState().setEditable(false)
    useUIStore.getState().setDirty(true)
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByTestId('status-save-region'))
    const save = await screen.findByTestId('sb-save')
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(save).toHaveAttribute('title', 'Switch to edit mode first')
    expect(screen.getByTestId('sb-save-as')).toHaveAttribute('title', 'Switch to edit mode first')
    expect(screen.getByTestId('sb-reload')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('greys save when there is nothing to save', async () => {
    useUIStore.getState().setDirty(false)
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByTestId('status-save-region'))
    // Not dirty => nothing to save, so the item greys out (same rule as the toolbar).
    expect(await screen.findByTestId('sb-save')).toHaveAttribute('aria-disabled', 'true')
  })

  it('switches the line ending to LF from the context menu after confirming (能力 6)', async () => {
    installApi(async () => '\r\n')
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByText('CRLF'))
    fireEvent.click(await screen.findByTestId('sb-switch-lf'))
    await waitFor(() =>
      expect(mockSetEol).toHaveBeenCalledWith({ filePath: '/tmp/a.md', eol: '\n' }),
    )
    expect(mockReload).toHaveBeenCalledWith('d1')
  })

  it('copies the line-ending name as CRLF when the document uses Windows line endings', async () => {
    installApi(async () => '\r\n')
    render(<StatusBar />)
    fireEvent.contextMenu(await screen.findByText('CRLF'))
    fireEvent.click(await screen.findByTestId('sb-copy-line-ending'))
    expect(mockWriteText).toHaveBeenLastCalledWith('CRLF')
  })
})
