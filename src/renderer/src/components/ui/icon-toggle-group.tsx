import React from 'react'
import { cn } from '../../lib/utils'

export interface ToggleItem {
  key: string
  // Visible glyph (e.g. Aa / ab / .* / AB).
  label: string
  active: boolean
  // Tooltip and accessible name.
  title: string
  ariaLabel: string
  disabled?: boolean
}

interface IconToggleGroupProps {
  items: ToggleItem[]
  onToggle: (key: string) => void
  testId: string
}

// A row of small toggle buttons (Aa / ab / .* / AB) shared by the editor and
// preview find widgets. Each button reports its pressed state via `aria-pressed`.
export function IconToggleGroup({
  items,
  onToggle,
  testId,
}: IconToggleGroupProps): React.ReactElement {
  return (
    <div
      data-testid={testId}
      className="flex items-center rounded border border-[var(--color-border)] overflow-hidden shrink-0"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          data-testid={`${testId}-${item.key}`}
          aria-label={item.ariaLabel}
          aria-pressed={item.active}
          title={item.title}
          disabled={item.disabled}
          onClick={() => onToggle(item.key)}
          className={cn(
            'px-1.5 py-0.5 text-xs font-medium transition-colors',
            'first:border-l-0 border-l border-[var(--color-border)]',
            item.active
              ? 'bg-[var(--color-accent-muted)] text-accent'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]',
            item.disabled && 'opacity-40 cursor-not-allowed',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
