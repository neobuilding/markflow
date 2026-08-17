import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { AboutDialog } from './AboutDialog'
import { useUIStore } from '../../store/ui'
import '../../i18n'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AboutDialog', () => {
  beforeEach(() => {
    useUIStore.getState().setAboutOpen(false)
  })

  it('renders nothing when closed', () => {
    useUIStore.getState().setAboutOpen(false)
    const { container } = render(<AboutDialog />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('fetches and shows the version when opened', async () => {
    const getVersion = vi.fn().mockResolvedValue('1.2.3')
    ;(window as unknown as { api: { app: { getVersion: typeof getVersion } } }).api = {
      app: { getVersion },
    }
    useUIStore.getState().setAboutOpen(true)
    render(<AboutDialog />)
    expect(await screen.findByText('1.2.3')).toBeInTheDocument()
    expect(getVersion).toHaveBeenCalled()
  })

  it('falls back to "unknown" when version fetch fails', async () => {
    const getVersion = vi.fn().mockRejectedValue(new Error('nope'))
    ;(window as unknown as { api: { app: { getVersion: typeof getVersion } } }).api = {
      app: { getVersion },
    }
    useUIStore.getState().setAboutOpen(true)
    render(<AboutDialog />)
    expect(await screen.findByText('unknown')).toBeInTheDocument()
  })

  it('closes when the close button is clicked', async () => {
    const getVersion = vi.fn().mockResolvedValue('1.0.0')
    ;(window as unknown as { api: { app: { getVersion: typeof getVersion } } }).api = {
      app: { getVersion },
    }
    useUIStore.getState().setAboutOpen(true)
    render(<AboutDialog />)
    await screen.findByText('1.0.0')
    fireEvent.click(screen.getByText('Close'))
    expect(useUIStore.getState().aboutOpen).toBe(false)
  })

  it('closes via the dialog onOpenChange when dismissed', async () => {
    const getVersion = vi.fn().mockResolvedValue('1.0.0')
    ;(window as unknown as { api: { app: { getVersion: typeof getVersion } } }).api = {
      app: { getVersion },
    }
    useUIStore.getState().setAboutOpen(true)
    render(<AboutDialog />)
    await screen.findByText('1.0.0')
    // The Dialog closes on Escape, which fires onOpenChange(false) -> close().
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(useUIStore.getState().aboutOpen).toBe(false))
  })

  it('copies the version to the clipboard and shows the copied state', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const getVersion = vi.fn().mockResolvedValue('1.0.0')
    ;(window as unknown as { api: { app: { getVersion: typeof getVersion } } }).api = {
      app: { getVersion },
    }
    useUIStore.getState().setAboutOpen(true)
    render(<AboutDialog />)
    await screen.findByText('1.0.0')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1.0.0'))
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })
})
