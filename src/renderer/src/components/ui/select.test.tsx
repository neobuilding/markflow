import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Select } from './select'

// ADR-0024 §4 (UI control reuse) + §"One focus indicator": the dialog selects must come from this
// primitive, carry the shared `.focus-ring`, and match the 36px field height. Two dialogs used to
// hand-roll their own ring — one of them 1px — which is what these assertions pin down.

describe('Select primitive', () => {
  it('carries the shared focus-ring, not a hand-rolled one', () => {
    render(<Select aria-label="ext" />)
    const el = screen.getByLabelText('ext')
    expect(el.className).toContain('focus-ring')
    // The hand-rolled variants that used to exist on two dialog selects.
    expect(el.className).not.toContain('focus:ring-1')
    expect(el.className).not.toContain('focus:ring-2')
    // `focus:ring-0` removes the indicator entirely (a straight WCAG 2.4.7 failure).
    expect(el.className).not.toContain('ring-0')
  })

  it('matches the 36px dialog field height of Input', () => {
    render(<Select aria-label="ext" />)
    expect(screen.getByLabelText('ext').className).toContain('h-9')
  })

  it('forwards the value/onChange contract to the native element', () => {
    render(
      <Select aria-label="ext" value=".mdx" onChange={() => {}}>
        <option value=".md">.md</option>
        <option value=".mdx">.mdx</option>
      </Select>,
    )
    expect((screen.getByLabelText('ext') as HTMLSelectElement).value).toBe('.mdx')
  })
})
