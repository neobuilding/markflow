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
})
