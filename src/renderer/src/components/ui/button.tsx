import * as React from 'react'
import { cn } from '../../lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'destructive' | 'outline' | 'accent'
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
            'bg-[var(--color-danger)] text-white hover:opacity-90 active:scale-[0.98]':
              variant === 'destructive',
            'border border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-overlay)] active:scale-[0.98]':
              variant === 'outline',
            'bg-accent text-white hover:bg-[var(--color-accent-hover)] active:scale-[0.98]':
              variant === 'accent'
          },
          {
            // sizes
            'h-7 px-2.5 text-xs': size === 'sm',
            'h-8 px-3 text-sm': size === 'md',
            'h-7 w-7 p-0': size === 'icon'
          },
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'
