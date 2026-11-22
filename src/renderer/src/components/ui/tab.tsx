import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

// ADR-0040 / ADR-0024 §4: a single tab in the editor tab strip. ADR-0024 keeps primitives
// DOM-only and unstyled where possible; this one is app-specific (icons + dirty dot) so the
// styling lives here and callers only pass state/callbacks.

export interface TabProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  label: string
  active?: boolean
  dirty?: boolean
  external?: boolean
  closable?: boolean
  closeLabel?: string
  onClose?: () => void
  /** Forwarded to the tab strip's keyboard handler (arrow keys). */
  onActivate?: () => void
}

export const TAB_MIME = 'application/x-markflow-tab'

export const Tab = React.forwardRef<HTMLDivElement, TabProps>(
  (
    {
      label,
      active = false,
      dirty = false,
      external = false,
      closable = true,
      closeLabel = 'Close tab',
      onClose,
      onActivate,
      className,
      onClick,
      onKeyDown,
      ...rest
    },
    ref,
  ) => (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable
      data-active={active || undefined}
      data-dirty={dirty || undefined}
      className={cn(
        'group relative flex h-full min-w-0 max-w-[200px] items-center gap-1.5 px-2.5 text-sm select-none',
        'border-r border-[var(--color-border)] outline-none transition-colors cursor-pointer',
        active
          ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)] focus-ring'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] focus-ring',
        className,
      )}
      onClick={(e) => {
        onActivate?.()
        onClick?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate?.()
        }
        onKeyDown?.(e)
      }}
      {...rest}
    >
      {dirty ? (
        <span
          data-testid="tab-dirty-dot"
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)] text-accent"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
        {external ? <span className="ml-1 text-[10px] opacity-60">↗</span> : null}
      </span>
      {closable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={closeLabel}
              data-testid="tab-close"
              className="shrink-0 rounded p-0.5 opacity-60 hover:bg-[var(--color-surface-overlay)] hover:opacity-100 focus-ring"
              onClick={(e) => {
                e.stopPropagation()
                onClose?.()
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  ),
)
Tab.displayName = 'Tab'
