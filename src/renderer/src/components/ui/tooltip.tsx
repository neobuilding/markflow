import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

/**
 * The app's tooltips are informational only (a name plus, optionally, the keyboard shortcut) —
 * none of them carries an interactive control. Radix's default "hoverable content" mode therefore
 * buys nothing and costs two real problems:
 *
 *   - the bubble stays open while the pointer travels over it and it swallows the pointer, so the
 *     NEXT control of a toolbar can be neither hovered nor clicked while a tooltip is up;
 *   - leaving a trigger whose bubble is open arms Radix's "pointer grace area", which sets
 *     `isPointerInTransitRef` — and the next trigger then IGNORES its pointermove, so the second
 *     tooltip in a row never opens. That is what broke reading the format cluster's shortcut
 *     glyphs one by one (ADR-0032).
 *
 * `disableHoverableContent` drops the hoverable variant entirely; `pointer-events-none` on the
 * bubble (below) keeps it from ever intercepting the pointer.
 */
const TooltipProvider = (props: React.ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider disableHoverableContent {...props} />
)
TooltipProvider.displayName = 'TooltipProvider'

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
        // `pointer-events-none`: Radix does NOT disable pointer events on the content, so the bubble
        // would otherwise swallow the pointer. A tooltip that covers the next toolbar button blocks
        // both hovering it (the shortcut glyphs are read by hovering along the format cluster) and
        // clicking it. The bubble is informational, so it must never intercept the pointer.
        'z-50 overflow-hidden rounded-md border px-2.5 py-1.5 text-xs font-medium leading-none shadow-linear-lg animate-fade-in pointer-events-none',
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
