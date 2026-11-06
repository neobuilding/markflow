import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { NewDocumentDialog } from './NewDocumentDialog'
import { useUIStore } from '../../store/ui'
import * as useDocuments from '../../hooks/useDocuments'
import '../../i18n'

// Mock the document-creation hook so we can assert the create flow without
// touching the real (Electron-backed) API.
vi.mock('../../hooks/useDocuments', () => ({
  useCreateDocument: vi.fn(() => ({ mutateAsync: mockMutateAsync, isPending: false })),
  useDocument: () => ({ data: undefined }),
  useSetEncoding: () => ({ mutateAsync: vi.fn() }),
  useDocuments: () => ({ data: [] }),
  useFileStat: () => ({ data: undefined }),
}))

const mockMutateAsync = vi.fn()

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockMutateAsync.mockReset()
})

describe('NewDocumentDialog', () => {
  beforeEach(() => {
    useUIStore.getState().setNewDocOpen(false)
    // Reset the creation hook to its default: a previous test may have left `isPending`
    // on, which would disable the Create button for every test that follows.
    vi.mocked(useDocuments.useCreateDocument).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useDocuments.useCreateDocument>)
  })

  it('does not render the dialog when closed', () => {
    useUIStore.getState().setNewDocOpen(false)
    const { container } = render(<NewDocumentDialog />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens and creates a document with the entered title + default ext', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-1' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'My Note' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ title: 'My Note', ext: '.md' }),
    )
    expect(useUIStore.getState().activeDocumentId).toBe('doc-1')
    expect(useUIStore.getState().editable).toBe(true)
    expect(useUIStore.getState().isNewUnsaved).toBe(true)
    expect(useUIStore.getState().newDocOpen).toBe(false)
  })

  it('falls back to "Untitled" when the title is blank', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-2' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ title: 'Untitled', ext: '.md' }),
    )
  })

  it('cancels without creating', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    await screen.findByPlaceholderText('Untitled')
    fireEvent.click(screen.getByText('Cancel'))
    expect(useUIStore.getState().newDocOpen).toBe(false)
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('submits on Enter key', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-3' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'Enter Doc' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ title: 'Enter Doc', ext: '.md' }),
    )
  })

  it('closes on Escape without creating', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useUIStore.getState().newDocOpen).toBe(false)
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('honours the selected extension', async () => {
    mockMutateAsync.mockResolvedValue({ id: 'doc-4' })
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'Ext Doc' } })
    fireEvent.change(screen.getByDisplayValue('.md'), { target: { value: '.mdx' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ title: 'Ext Doc', ext: '.mdx' }),
    )
  })

  it('the extension select comes from the shared Select primitive (one focus ring, 36px)', async () => {
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const select = await screen.findByDisplayValue('.md')
    expect(select.className).toContain('focus-ring')
    expect(select.className).toContain('h-9')
    // The hand-rolled 2px ring + `outline-none` this used to carry.
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

  // D23 / §5.9: the new document does not exist yet, so the guard cannot go through
  // `selectDocument` — it must run BEFORE the create, and a decline must leave no orphan.
  it('guards before creating when the current document has unsaved edits', async () => {
    const confirm: ReturnType<typeof vi.fn> = vi.fn(async () => false)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    useUIStore.getState().setActiveDocumentId('open-doc')
    useUIStore.getState().setActiveDocumentTitle('Open doc')
    useUIStore.getState().setDirty(true)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'My Note' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    // The dialog names the document being left, and cancelling creates NOTHING — no orphan
    // draft, no switch.
    expect(confirm.mock.calls[0][0].message).toContain('Open doc')
    expect(mockMutateAsync).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeDocumentId).toBe('open-doc')
  })

  it('creates only after the unsaved-switch guard is confirmed', async () => {
    const confirm: ReturnType<typeof vi.fn> = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    mockMutateAsync.mockResolvedValue({ id: 'doc-guarded' })
    useUIStore.getState().setActiveDocumentId('open-doc')
    useUIStore.getState().setActiveDocumentTitle('Open doc')
    useUIStore.getState().setDirty(true)
    useUIStore.getState().setNewDocOpen(true)
    render(<NewDocumentDialog />)
    const input = await screen.findByPlaceholderText('Untitled')
    fireEvent.change(input, { target: { value: 'My Note' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ title: 'My Note', ext: '.md' }),
    )
    expect(useUIStore.getState().activeDocumentId).toBe('doc-guarded')
  })
})
