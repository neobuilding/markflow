import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SearchInput } from './search-input'

describe('SearchInput', () => {
  it('renders the input with placeholder and aria-label', () => {
    render(
      <SearchInput
        value=""
        onChange={() => {}}
        placeholder="Find"
        ariaLabel="Find in editor"
        testId="editor-find-input"
      />,
    )
    const input = screen.getByTestId('editor-find-input') as HTMLInputElement
    expect(input.placeholder).toBe('Find')
    expect(input.getAttribute('aria-label')).toBe('Find in editor')
  })

  it('calls onChange when the user types', () => {
    const onChange = vi.fn()
    render(
      <SearchInput
        value=""
        onChange={onChange}
        placeholder="Find"
        ariaLabel="Find"
        testId="editor-find-input"
      />,
    )
    fireEvent.change(screen.getByTestId('editor-find-input'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  it('shows a clear button only when there is text and onClear is provided', () => {
    const onClear = vi.fn()
    const { rerender } = render(
      <SearchInput
        value=""
        onChange={() => {}}
        placeholder="Find"
        ariaLabel="Find"
        testId="editor-find-input"
        onClear={onClear}
      />,
    )
    expect(screen.queryByTestId('editor-find-input-clear')).toBeNull()
    rerender(
      <SearchInput
        value="abc"
        onChange={() => {}}
        placeholder="Find"
        ariaLabel="Find"
        testId="editor-find-input"
        onClear={onClear}
      />,
    )
    const clear = screen.getByTestId('editor-find-input-clear')
    expect(clear).toBeInTheDocument()
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('tags the input with main-field when requested', () => {
    render(
      <SearchInput
        value=""
        onChange={() => {}}
        placeholder="Find"
        ariaLabel="Find"
        testId="editor-find-input"
        mainField
      />,
    )
    expect(screen.getByTestId('editor-find-input').getAttribute('main-field')).toBe('true')
  })
})
