import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // Inverted tooltip per design fig 02: dark-navy bubble (#1F2937 == --color-text-primary)
        // + white text + NO visible border (the SVG has stroke == fill). PLAN C22 forbids inline hex,
        // so both themes are pure tokens: bubble = --color-text-primary, text = --color-bg. This
        // matches the diagram in light and keeps a token-only, C22-compliant bubble in dark.
        'z-50 overflow-hidden rounded-md border px-2.5 py-1.5 text-xs font-medium leading-none shadow-linear-lg animate-fade-in',
        'bg-[var(--color-text-primary)] border-[var(--color-text-primary)] text-white',
        'dark:bg-[var(--color-text-primary)] dark:border-[var(--color-text-primary)] dark:text-[var(--color-bg)]',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent }
