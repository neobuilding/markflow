import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TitleBar } from './titlebar'
import { useUIStore } from '../../store/ui'

afterEach(() => cleanup())

describe('TitleBar', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(navigator, 'platform', originalPlatform)
    } else {
      delete (navigator as unknown as { platform?: string }).platform
    }
    vi.restoreAllMocks()
  })

  function setPlatform(p: string): void {
    Object.defineProperty(navigator, 'platform', { value: p, configurable: true })
  }

  beforeEach(() => {
    useUIStore.getState().setSidebarOpen(true)
  })

  it('shows the macOS traffic-light spacer on mac', () => {
    setPlatform('MacIntel')
    const { container } = render(<TitleBar />)
    expect(container.querySelector('.titlebar-no-drag')).not.toBeNull()
  })

  it('does not render the sidebar toggle button when the sidebar is open', () => {
    setPlatform('Win32')
    useUIStore.getState().setSidebarOpen(true)
    render(<TitleBar />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the sidebar toggle and calls toggleSidebar when the sidebar is closed', () => {
    setPlatform('Win32')
    useUIStore.getState().setSidebarOpen(false)
    const toggle = vi.spyOn(useUIStore.getState(), 'toggleSidebar')
    render(<TitleBar />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    expect(toggle).toHaveBeenCalled()
  })
})
