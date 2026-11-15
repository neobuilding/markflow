import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { NewDocumentDialog } from './NewDocumentDialog'
import { useUIStore } from '../../store/ui'
import * as useDocuments from '../../hooks/useDocuments'
import '../../i18n'

// "New File…" writes a REAL Markdown file into the open folder — the VS Code File > New File…
// counterpart to the always-available memory-only "New Draft". These tests pin that contract:
// memoryOnly:false, folderPath, no Save-As prompt afterwards, and visible errors when the name
// is taken or invalid.
vi.mock('../../hooks/useDocuments', () => ({
  useCreateDocument: vi.fn(() => ({ mutateAsync: mockMutateAsync, isPending: false })),
  useDocument: () => ({ data: undefined }),
  useSetEncoding: () => ({ mutateAsync: vi.fn() }),
  useDocuments: () => ({ data: [] }),
  useFileStat: () => ({ data: undefined }),
}))

const mockMutateAsync = vi.fn()
const stat = vi.fn(async () => null)
// Typed to the native confirm contract: without the parameter the mock's `calls[0][0]` is a
// zero-length tuple, so asserting on the message ("which document is being left?") would not type.
const confirm = vi.fn(
  async (_opts: { message: string; okText?: string; cancelText?: string }): Promise<boolean> =>
    true,
)

const FOLDER = '/notes'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockMutateAsync.mockReset()
})

describe('NewDocumentDialog ("New File…")', () => {
  beforeEach(() => {
    stat.mockClear().mockResolvedValue(null)
    confirm.mockClear().mockResolvedValue(true)
    ;(window as unknown as { api: unknown }).api = {
      dialog: { confirm },
      documents: { stat },
    }
    useUIStore.getState().setNewDocOpen(false)
    useUIStore.getState().setDirty(false)
    useUIStore.getState().setActiveFolder(FOLDER)
    vi.mocked(useDocuments.useCreateDocument).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useDocuments.useCreateDocument>)
  })

  const expectCreated = async (title: string, ext: string) => {
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        title,
        ext,
        folderPath: FOLDER,
        memoryOnly: false,
      }),
    )
  }

  it('does not render the dialog when closed', () => {
    const { container } = render(<NewDocumentDialog />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('creates a real file with the entered name + default extension', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-1' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'My Note' },
    })
    fireEvent.click(screen.getByText('Create'))
    await expectCreated('My Note', '.md')
    expect(stat).toHaveBeenCalledWith(expect.stringContaining('My Note.md'))
    expect(useUIStore.getState().activeDocumentId).toBe('doc-1')
    expect(useUIStore.getState().editable).toBe(true)
    // Already on disk: Save must NOT open Save As.
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
    expect(useUIStore.getState().newDocOpen).toBe(false)
  })

  it('falls back to "Untitled" when the title is blank', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-2' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByText('Create'))
    await expectCreated('Untitled', '.md')
  })

  it('cancels without creating', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    await screen.findByPlaceholderText('Untitled')
    fireEvent.click(screen.getByText('Cancel'))
    expect(useUIStore.getState().newDocOpen).toBe(false)
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  // Enter is a second path to create that does not go through the (disabled) Create button: a
  // double Enter must not fire two creates, whose loser would report EEXIST after the dialog closed.
  it('ignores Enter while a create is already in flight', async () => {
    vi.mocked(useDocuments.useCreateDocument).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: true,
    } as unknown as ReturnType<typeof useDocuments.useCreateDocument>)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'Race' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  // The dialog stays mounted for the whole session, so a cancelled attempt would otherwise reopen
  // carrying the previous name and error banner.
  it('clears the name, extension and error when it is closed', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'Leftover' } })
    fireEvent.click(screen.getByText('Create'))
    await screen.findByTestId('new-file-error')

    fireEvent.click(screen.getByText('Cancel'))
    // Reopen the way the File menu does.
    useUIStore.getState().setNewDocOpen(true)
    const reopened = await screen.findByPlaceholderText('Untitled')
    expect(reopened).toHaveValue('')
    expect(screen.queryByTestId('new-file-error')).toBeNull()
  })

  it('submits on Enter key', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-3' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'Enter Doc' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await expectCreated('Enter Doc', '.md')
  })

  it('closes on Escape without creating', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.keyDown(await screen.findByPlaceholderText('Untitled'), { key: 'Escape' })
    expect(useUIStore.getState().newDocOpen).toBe(false)
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('honours the selected extension', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-4' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Ext Doc' },
    })
    fireEvent.change(screen.getByDisplayValue('.md'), { target: { value: '.mdx' } })
    fireEvent.click(screen.getByText('Create'))
    await expectCreated('Ext Doc', '.mdx')
  })

  // ADR-0011: the name field decides the file name. Before this, typing an extension produced
  // `Notes.md.md` on disk while the sidebar's inline row produced `Notes.md` for the same input.
  it('does not double an extension typed into the name field', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-ext' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Notes.md' },
    })
    fireEvent.click(screen.getByText('Create'))
    await expectCreated('Notes', '.md')
    expect(stat).toHaveBeenCalledWith(expect.stringContaining('/notes/Notes.md'))
  })

  it('lets a typed Markdown extension override the selector', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-ext2' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Notes.markdown' },
    })
    fireEvent.click(screen.getByText('Create'))
    await expectCreated('Notes', '.markdown')
  })

  it('refuses an unsupported extension instead of writing an unopenable file', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Notes.txt' },
    })
    fireEvent.click(screen.getByText('Create'))
    expect(await screen.findByTestId('new-file-error')).toHaveTextContent(
      'has an unsupported extension',
    )
    expect(mockMutateAsync).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })

  it('offers exactly the five Markdown extensions from the shared set', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const options = Array.from(
      (await screen.findByDisplayValue('.md')).querySelectorAll('option'),
    ).map((o) => o.value)
    expect(options).toEqual(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])
  })

  it('the extension select comes from the shared Select primitive (one focus ring, 36px)', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const select = await screen.findByDisplayValue('.md')
    expect(select.className).toContain('focus-ring')
    expect(select.className).toContain('h-9')
    expect(select.className).not.toContain('focus:ring-2')
    expect(select.className).not.toContain('outline-none')
  })

  it('disables the Create button while a creation is pending', async () => {
    vi.mocked(useDocuments.useCreateDocument).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: true,
    } as unknown as ReturnType<typeof useDocuments.useCreateDocument>)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    await screen.findByPlaceholderText('Untitled')
    expect(screen.getByText('Create')).toBeDisabled()
  })

  it('is unusable with no active folder (filesystem-bound command)', async () => {
    useUIStore.getState().setActiveFolder(null)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    await screen.findByPlaceholderText('Untitled')
    expect(screen.getByText('Create')).toBeDisabled()
    fireEvent.keyDown(screen.getByPlaceholderText('Untitled'), { key: 'Enter' })
    expect(await screen.findByTestId('new-file-error')).toHaveTextContent(
      'Open a folder before creating a file',
    )
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('refuses a name that already exists in the folder', async () => {
    stat.mockResolvedValue({ exists: true } as never)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Taken' },
    })
    fireEvent.click(screen.getByText('Create'))
    expect(await screen.findByTestId('new-file-error')).toHaveTextContent('already exists')
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('shows the name clash when O_EXCL loses the race after stat()', async () => {
    mockMutateAsync.mockRejectedValue(new Error('EEXIST: file already exists'))
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Raced' },
    })
    fireEvent.click(screen.getByText('Create'))
    expect(await screen.findByTestId('new-file-error')).toHaveTextContent('already exists')
  })

  it('reports an unexpected create failure instead of failing silently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockMutateAsync.mockRejectedValue(new Error('disk full'))
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'Oops' },
    })
    fireEvent.click(screen.getByText('Create'))
    expect(await screen.findByTestId('new-file-error')).toHaveTextContent('disk full')
  })

  it('refuses an invalid base name', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'bad/name' },
    })
    fireEvent.click(screen.getByText('Create'))
    expect(await screen.findByTestId('new-file-error')).toHaveTextContent('not a valid file name')
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  // D23 / §5.9: the new document does not exist yet, so the guard cannot go through
  // `selectDocument` — it must run BEFORE the create, and a decline must leave no orphan.
  it('guards before creating when the current document has unsaved edits', async () => {
    confirm.mockResolvedValue(false)
    useUIStore.getState().setActiveDocumentId('open-doc')
    useUIStore.getState().setActiveDocumentTitle('Open doc')
    useUIStore.getState().setDirty(true)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'My Note' },
    })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0].message).toContain('Open doc')
    expect(mockMutateAsync).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBe('open-doc')
  })

  it('creates only after the unsaved-switch guard is confirmed', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-guarded' })
    useUIStore.getState().setActiveDocumentId('open-doc')
    useUIStore.getState().setActiveDocumentTitle('Open doc')
    useUIStore.getState().setDirty(true)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    fireEvent.change(await screen.findByPlaceholderText('Untitled'), {
      target: { value: 'My Note' },
    })
    fireEvent.click(screen.getByText('Create'))
    await expectCreated('My Note', '.md')
    expect(useUIStore.getState().activeDocumentId).toBe('doc-guarded')
  })
})
