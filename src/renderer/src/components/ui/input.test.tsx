import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { createRef } from 'react'
import { Input } from './input'

afterEach(() => cleanup())

describe('Input', () => {
  it('renders an input and forwards props', () => {
    render(<Input placeholder="Name" data-testid="name" />)
    const el = screen.getByTestId('name')
    expect(el.tagName).toBe('INPUT')
    expect(el).toHaveAttribute('placeholder', 'Name')
  })

  it('merges the passed className with the base classes', () => {
    render(<Input className="custom-class" data-testid="i" />)
    expect(screen.getByTestId('i')).toHaveClass('custom-class')
    expect(screen.getByTestId('i')).toHaveClass('w-full')
  })

  it('forwards a ref to the underlying input element', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
  })

  it('fires onChange when typed into', () => {
    const onChange = vi.fn()
    render(<Input data-testid="i" onChange={onChange} />)
    fireEvent.change(screen.getByTestId('i'), { target: { value: 'x' } })
    expect(onChange).toHaveBeenCalled()
  })

  // PLAN C32 U8 / ADR-0024 §7.2: every focusable control shows EXACTLY ONE focus indicator.
  // `Input` used to paint two at once (a focus ring + a focus border), which reads as a broken
  // control and doubles the visual weight of the focus state.
  it('exposes exactly one focus indicator', () => {
    render(<Input data-testid="i" />)
    const el = screen.getByTestId('i')
    expect(el.className).toContain('focus-ring')
    expect(el.className).not.toContain('focus:ring-1')
    expect(el.className).not.toContain('focus:ring-2')
    expect(el.className).not.toContain('focus:border-accent')
  })
})
