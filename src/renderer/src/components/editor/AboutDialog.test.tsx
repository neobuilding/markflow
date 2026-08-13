import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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
})
