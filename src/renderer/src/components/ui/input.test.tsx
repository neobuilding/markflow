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
})
