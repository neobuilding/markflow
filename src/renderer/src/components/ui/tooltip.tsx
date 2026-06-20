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
        // Linear-style tooltip: dark charcoal bg, crisp white text,
        // subtle shadow, smooth animation — no more "black blob".
        // Uses dark: variant so dark theme gets a slightly lighter bg.
        'z-50 overflow-hidden rounded-md border px-2.5 py-1.5 text-xs font-medium leading-none shadow-lg animate-fade-in',
        'bg-[#1a1a1a] border-black/40 text-white',
        'dark:bg-[#2a2a2a] dark:border-[var(--color-border-strong)]',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent }
