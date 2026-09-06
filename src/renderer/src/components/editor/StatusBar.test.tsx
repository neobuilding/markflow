import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { useUIStore } from '../../store/ui'
import '../../i18n'

const mockMutateAsync = vi.fn()
const mockSetEol = vi.fn()
const mockReload = vi.fn()
const mockDetect = vi.fn()

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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockMutateAsync.mockReset()
  mockSetEol.mockReset()
  mockReload.mockReset()
  mockDetect.mockReset()
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
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
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    const pill = await screen.findByTitle(/encoding/i)
    fireEvent.click(pill)
    expect(await screen.findByText('UTF-8')).toBeInTheDocument()
    // mousedown lands inside the pill container, so the outside-click guard ignores it.
    fireEvent.mouseDown(pill)
    expect(screen.getByText('UTF-8')).toBeInTheDocument()
  })

  it('switches the line ending to CRLF on disk and reloads (能力 6)', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    fireEvent.click(await screen.findByText(/Switch to CRLF|切换为 CRLF/i))
    await waitFor(() =>
      expect(mockSetEol).toHaveBeenCalledWith({ filePath: '/tmp/a.md', eol: '\r\n' }),
    )
    expect(mockReload).toHaveBeenCalledWith('d1')
  })

  it('does not switch when the target line ending is already active', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    const lfItem = await screen.findByText(/Switch to LF|切换为 LF/i)
    expect(lfItem).toBeDisabled()
    fireEvent.click(lfItem)
    expect(mockSetEol).not.toHaveBeenCalled()
  })

  it('re-detects encoding from disk and applies it (能力 11)', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    mockDetect.mockResolvedValue({ enc: 'GB2312', confidence: 0.8 })
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    fireEvent.click(await screen.findByText(/Re-detect encoding|重新检测编码/))
    await waitFor(() => expect(mockDetect).toHaveBeenCalledWith('/tmp/a.md'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ id: 'd1', encoding: 'GB2312' }),
    )
  })

  it('shows the detecting label while re-detection is in flight (能力 11)', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    let resolveDetect!: (v: { enc: string; confidence: number }) => void
    const detect = vi.fn(
      () =>
        new Promise<{ enc: string; confidence: number }>((res) => {
          resolveDetect = res
        }),
    )
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof detect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: detect, setEol: mockSetEol, reload: mockReload },
    }
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
    const eol = vi.fn().mockResolvedValue('\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    expect(await screen.findByText(/Re-detect encoding|重新检测编码/)).toBeDisabled()
  })

  it('logs a failure when the line-ending switch rejects (能力 6)', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSetEol.mockRejectedValueOnce(new Error('boom'))
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    fireEvent.click(await screen.findByText(/Switch to CRLF|切换为 CRLF/i))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('logs a failure when re-detect encoding rejects (能力 11)', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    mockDetect.mockRejectedValueOnce(new Error('boom'))
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<StatusBar />)
    fireEvent.click(await screen.findByTitle(/encoding/i))
    fireEvent.click(await screen.findByText(/Re-detect encoding|重新检测编码/))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('switches the line ending to LF on disk and reloads (能力 6)', async () => {
    const eol = vi.fn().mockResolvedValue('\r\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('CRLF'))
    fireEvent.click(await screen.findByText(/Switch to LF|切换为 LF/i))
    await waitFor(() =>
      expect(mockSetEol).toHaveBeenCalledWith({ filePath: '/tmp/a.md', eol: '\n' }),
    )
    expect(mockReload).toHaveBeenCalledWith('d1')
  })

  it('closes the line-ending dropdown when clicking outside', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    fireEvent.click(await screen.findByText('LF'))
    expect(await screen.findByText(/Switch to CRLF|切换为 CRLF/i)).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByText(/Switch to CRLF|切换为 CRLF/i)).toBeNull())
  })

  it('keeps the line-ending dropdown open when clicking inside the pill', async () => {
    const eol = vi.fn().mockResolvedValue('\n')
    ;(
      window as unknown as {
        api: {
          documents: {
            eol: typeof eol
            detectEncoding: typeof mockDetect
            setEol: typeof mockSetEol
            reload: typeof mockReload
          }
        }
      }
    ).api = {
      documents: { eol, detectEncoding: mockDetect, setEol: mockSetEol, reload: mockReload },
    }
    render(<StatusBar />)
    const pill = await screen.findByText('LF')
    fireEvent.click(pill)
    expect(await screen.findByText(/Switch to CRLF|切换为 CRLF/i)).toBeInTheDocument()
    fireEvent.mouseDown(pill)
    expect(screen.getByText(/Switch to CRLF|切换为 CRLF/i)).toBeInTheDocument()
  })
})
