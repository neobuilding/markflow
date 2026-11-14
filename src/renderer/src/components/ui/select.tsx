import * as React from 'react'
import { cn } from '../../lib/utils'

// Native <select>, styled like the other controls (ADR-0024 §4 "UI control reuse").
//
// It exists because two dialogs each hand-rolled a <select> with their own focus ring — one 1px,
// one 2px, neither using the shared `.focus-ring`. That is precisely the drift the ADR forbids:
// `.focus-ring` is the ONE focus indicator (`:focus-visible`-gated, 2px, forced-colors aware), and
// the 36px height now matches `Input` and the `md` button so dialog fields line up.
//
// The native element is kept on purpose: it gets the OS picker, keyboard behaviour and
// screen-reader semantics for free, and this app has no need for a custom listbox.
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'w-full h-9 px-2 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] transition-colors focus-ring disabled:opacity-50',
          className,
        )}
        {...props}
      />
    )
  },
)
Select.displayName = 'Select'
