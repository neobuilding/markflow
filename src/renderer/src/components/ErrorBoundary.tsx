import React from 'react'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Catches React render errors and displays a helpful message instead of
 * a blank white screen. Especially important in production where there's
 * no DevTools to see what went wrong.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  handleReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      const msg = this.state.error?.message ?? 'Unknown error'
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '2rem',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#1a1a1a',
          background: '#f7f7f7',
        }}>
          <div style={{
            maxWidth: '480px',
            textAlign: 'center',
          }}>
            <div style={{
              width: '48px',
              height: '48px',
              borderRadius: '12px',
              background: '#fee2e2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem',
              fontSize: '24px',
            }}>
              ⚠
            </div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: '0.875rem', color: '#666', marginBottom: '1rem' }}>
              The application encountered an unexpected error. Try reloading — your data is safe.
            </p>
            <pre style={{
              fontSize: '0.75rem',
              color: '#999',
              background: '#fff',
              border: '1px solid #e5e5e5',
              borderRadius: '6px',
              padding: '0.75rem',
              textAlign: 'left',
              overflow: 'auto',
              maxHeight: '120px',
              marginBottom: '1rem',
            }}>
              {msg}
            </pre>
            <button
              onClick={this.handleReload}
              style={{
                padding: '0.5rem 1.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#fff',
                background: '#5b8def',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Reload App
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
