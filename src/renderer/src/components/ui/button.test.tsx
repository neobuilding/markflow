import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Button } from './button'

afterEach(() => cleanup())

describe('Button (RTL example)', () => {
  it('renders children', () => {
    render(<Button>Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('applies the icon size class', () => {
    render(<Button size="icon">★</Button>)
    expect(screen.getByRole('button', { name: '★' })).toHaveClass('h-8', 'w-8', 'p-0', 'shrink-0')
  })

  // PLAN C23 / ADR-0024 §1.3: hit areas move into the mandated 32-36px band and the toolbar
  // rows are `h-9` (36px). `icon` is 32px, not 36px -- a `h-9` row carries a 1px bottom border,
  // so its content box is 35px and a 36px button would overflow the row.
  it('keeps every size inside the 32-36px hit-area band', () => {
    const { rerender } = render(<Button size="sm">s</Button>)
    expect(screen.getByRole('button', { name: 's' })).toHaveClass('h-8')
    rerender(<Button size="md">m</Button>)
    expect(screen.getByRole('button', { name: 'm' })).toHaveClass('h-9')
    rerender(<Button size="icon">i</Button>)
    expect(screen.getByRole('button', { name: 'i' })).toHaveClass('h-8', 'w-8')
  })

  it('forwards onClick and is disabled when disabled', () => {
    const onClick = vi.fn()
    render(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Go' })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  // The `toolbar` variant is the design image's CONTAINED ICON TILE (fig 02/04 + ADR-0024 §1.4):
  // a white tile carrying the `--color-border` edge, and -- for a real toggle -- an accent-tinted
  // tile with an accent edge and accent glyph when it is pressed. The pressed look is driven by
  // `aria-pressed`, so it exists only where a control really has an on/off state.
  it('paints the toolbar variant as a white tile with the border edge and the muted glyph', () => {
    render(
      <Button variant="toolbar" size="icon" aria-label="Save">
        ★
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toHaveClass('bg-[var(--color-surface)]')
    expect(btn).toHaveClass('border-[var(--color-border)]')
    expect(btn).toHaveClass('text-[var(--color-text-secondary)]')
    // The focus ring and the disabled treatment come from the base class list, not from the variant.
    expect(btn).toHaveClass('focus-visible:ring-2')
    expect(btn).toHaveClass('disabled:opacity-50')
  })

  it('paints the pressed toolbar tile with the accent fill, edge and glyph', () => {
    render(
      <Button variant="toolbar" size="icon" aria-label="Read-only" aria-pressed="true">
        ★
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Read-only' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveClass('aria-[pressed=true]:bg-[var(--color-accent-muted)]')
    expect(btn).toHaveClass('aria-[pressed=true]:border-[var(--color-accent)]')
    expect(btn).toHaveClass('aria-[pressed=true]:text-accent')
  })

  it('leaves an unpressed toolbar tile on the rest look', () => {
    render(
      <Button variant="toolbar" size="icon" aria-label="Read-only" aria-pressed="false">
        ★
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Read-only' })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    // The rest look is the tile itself, not the accent fill.
    expect(btn).toHaveClass('bg-[var(--color-surface)]')
    expect(btn).toHaveClass('border-[var(--color-border)]')
  })
})
