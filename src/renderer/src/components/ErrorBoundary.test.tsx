import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { useUIStore } from '../store/ui'
import '../i18n'

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error('kaboom')
  return <div>safe content</div>
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('safe content')).toBeInTheDocument()
  })

  it('renders the error UI after a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('kaboom')).toBeInTheDocument()
  })

  it('logs the error via componentDidCatch', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    )
    expect(errorSpy).toHaveBeenCalled()
  })

  it('force-updates when the UI language changes', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('safe content')).toBeInTheDocument()
    // Switch language to trigger the subscribe callback's forceUpdate branch.
    act(() => {
      useUIStore.getState().setLanguage('en')
    })
    expect(screen.getByText('safe content')).toBeInTheDocument()
  })

  it('renders "Unknown error" when the error has no message', () => {
    // Force an error state with a null error object to exercise the
    // `error?.message ?? 'Unknown error'` fallback branch.
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    )
    act(() => {
      // getDerivedStateFromError is not invoked for manual state; simulate it
      // by throwing through a child wired to a null error.
      const boundary = screen.getByText('safe content')
      expect(boundary).toBeInTheDocument()
    })
    // Render a boundary that catches a null-throwing child.
    const NullError = (): React.ReactElement => {
      throw null
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <ErrorBoundary>
          <NullError />
        </ErrorBoundary>,
      )
      expect(screen.getByText('Unknown error')).toBeInTheDocument()
    } finally {
      spy.mockRestore()
    }
  })

  it('reload button triggers window.location.reload', () => {
    const reload = vi.fn()
    const originalLocation = window.location
    // jsdom makes `window.location` (and its `reload`) non-configurable, so we
    // swap the whole location object for a mock that records the reload call.
    const mockLocation = {
      ...originalLocation,
      reload,
    }
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      configurable: true,
      writable: true,
    })
    try {
      render(
        <ErrorBoundary>
          <Boom shouldThrow={true} />
        </ErrorBoundary>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Reload App' }))
      expect(reload).toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      })
    }
  })
})
