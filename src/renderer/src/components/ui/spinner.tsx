import * as React from 'react'
import { cn } from '../../lib/utils'

/**
 * Inline loading spinner. Uses `border-current` so it inherits the surrounding
 * text colour (e.g. white on an accent button). Decorative by default — pair it
 * with a visible status label rather than relying on it for meaning.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  )
}
