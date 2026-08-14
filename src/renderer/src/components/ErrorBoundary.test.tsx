import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { ErrorBoundary } from './ErrorBoundary'
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
