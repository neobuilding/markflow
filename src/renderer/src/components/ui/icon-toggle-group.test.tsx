import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IconToggleGroup, type ToggleItem } from './icon-toggle-group'

const items: ToggleItem[] = [
  { key: 'case', label: 'Aa', active: false, title: 'Match Case', ariaLabel: 'Match Case' },
  { key: 'word', label: 'ab', active: true, title: 'Whole Word', ariaLabel: 'Whole Word' },
  {
    key: 'regex',
    label: '.*',
    active: false,
    title: 'Regex',
    ariaLabel: 'Regex',
    disabled: true,
  },
]

describe('IconToggleGroup', () => {
  it('renders every toggle with its glyph and pressed state', () => {
    render(<IconToggleGroup items={items} onToggle={() => {}} testId="editor-find-toggles" />)
    expect(screen.getByTestId('editor-find-toggles-case').textContent).toBe('Aa')
    expect(screen.getByTestId('editor-find-toggles-case').getAttribute('aria-pressed')).toBe(
      'false',
    )
    expect(screen.getByTestId('editor-find-toggles-word').getAttribute('aria-pressed')).toBe('true')
  })

  it('calls onToggle with the toggle key on click', () => {
    const onToggle = vi.fn()
    render(<IconToggleGroup items={items} onToggle={onToggle} testId="editor-find-toggles" />)
    fireEvent.click(screen.getByTestId('editor-find-toggles-case'))
    expect(onToggle).toHaveBeenCalledWith('case')
  })

  it('does not fire onToggle for a disabled toggle', () => {
    const onToggle = vi.fn()
    render(<IconToggleGroup items={items} onToggle={onToggle} testId="editor-find-toggles" />)
    fireEvent.click(screen.getByTestId('editor-find-toggles-regex'))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
