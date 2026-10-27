import React from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

interface MatchCounterProps {
  current: number
  total: number
  // Text shown when there are no matches (e.g. "No match").
  noneLabel: string
  testId: string
  onPrev: () => void
  onNext: () => void
  prevLabel: string
  nextLabel: string
}

// The `k / n` match counter with previous/next steppers, shared by the editor and
// preview find widgets. The count is announced politely for screen readers.
export function MatchCounter({
  current,
  total,
  noneLabel,
  testId,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
}: MatchCounterProps): React.ReactElement {
  const label = total === 0 ? noneLabel : `${current} / ${total}`
  return (
    <div className="flex items-center gap-1 shrink-0" data-testid={testId}>
      <span
        data-testid={`${testId}-count`}
        aria-live="polite"
        className="text-2xs text-[var(--color-text-tertiary)] min-w-[2.5rem] text-center"
      >
        {label}
      </span>
      <button
        type="button"
        data-testid={`${testId}-prev`}
        aria-label={prevLabel}
        onClick={onPrev}
        className="p-1 rounded hover:bg-[var(--color-surface-overlay)]"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        data-testid={`${testId}-next`}
        aria-label={nextLabel}
        onClick={onNext}
        className="p-1 rounded hover:bg-[var(--color-surface-overlay)]"
      >
        <ChevronDown size={13} />
      </button>
    </div>
  )
}
