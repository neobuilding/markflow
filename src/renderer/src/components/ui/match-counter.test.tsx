import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MatchCounter } from './match-counter'

describe('MatchCounter', () => {
  it('shows the k / n count when there are matches', () => {
    render(
      <MatchCounter
        current={1}
        total={2}
        noneLabel="No match"
        testId="editor-find-count"
        onPrev={() => {}}
        onNext={() => {}}
        prevLabel="Previous"
        nextLabel="Next"
      />,
    )
    expect(screen.getByTestId('editor-find-count-count').textContent).toBe('1 / 2')
  })

  it('shows the none label when there are no matches', () => {
    render(
      <MatchCounter
        current={0}
        total={0}
        noneLabel="No match"
        testId="editor-find-count"
        onPrev={() => {}}
        onNext={() => {}}
        prevLabel="Previous"
        nextLabel="Next"
      />,
    )
    expect(screen.getByTestId('editor-find-count-count').textContent).toBe('No match')
  })

  it('fires prev / next', () => {
    const onPrev = vi.fn()
    const onNext = vi.fn()
    render(
      <MatchCounter
        current={1}
        total={2}
        noneLabel="No match"
        testId="editor-find-count"
        onPrev={onPrev}
        onNext={onNext}
        prevLabel="Previous"
        nextLabel="Next"
      />,
    )
    fireEvent.click(screen.getByTestId('editor-find-count-prev'))
    fireEvent.click(screen.getByTestId('editor-find-count-next'))
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})
