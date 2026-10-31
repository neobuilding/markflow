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
    expect(screen.getByRole('button', { name: '★' })).toHaveClass('h-8', 'w-8', 'p-0')
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
})
