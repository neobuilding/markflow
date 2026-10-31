import * as React from 'react'
import { cn } from '../../lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  // No `destructive` variant: it was the only consumer of `--color-danger` as a *fill* beneath
  // white text (3.91:1 on the dark theme), which is arithmetically incompatible with danger's
  // indicator role. It also had zero production call sites. Destructive affordance lives on
  // menu items, which use `--color-danger-text` (ADR-0024 §1.1). See PLAN C29.4.
  variant?: 'default' | 'ghost' | 'outline' | 'accent'
  size?: 'sm' | 'md' | 'icon'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:pointer-events-none select-none',
          {
            // variants
            'bg-[var(--color-surface)] text-[var(--color-text-primary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-overlay)] active:scale-[0.98]':
              variant === 'default',
            'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] active:scale-[0.98]':
              variant === 'ghost',
            'border border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-overlay)] active:scale-[0.98]':
              variant === 'outline',
            'bg-accent text-white hover:bg-[var(--color-accent-hover)] active:scale-[0.98]':
              variant === 'accent',
          },
          {
            // sizes -- ADR-0024 §1.3 ("Icon and target sizes"): hit areas move into the mandated
            // 32-36px band and the toolbar rows are `h-9` (36px).
            //   sm   28 -> 32px
            //   md   32 -> 36px (matches the `h-9` toolbar row and the `h-9` input)
            //   icon 28 -> 32px
            // The icon button is 32px, not 36px: a toolbar row is `h-9` WITH a 1px bottom border,
            // so its content box is 35px -- a 36px hit area would overflow the row by 1px and
            // overlap the separator. 32px is the lower end of the ADR's 32-36px range and keeps
            // E8 ("toolbar buttons >= 32px") true.
            'h-8 px-2.5 text-xs': size === 'sm',
            'h-9 px-3 text-sm': size === 'md',
            'h-8 w-8 p-0': size === 'icon',
          },
          className,
        )}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'
