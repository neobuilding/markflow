import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { cn } from '../../lib/utils'

// Right-click (contextmenu) menu wrapper built on @radix-ui/react-context-menu.
// Mirrors the visual API of dropdown-menu.tsx so the two share the same look.
// Key differences from DropdownMenu:
//   - Opens at the mouse position (native contextmenu semantics), not anchored to a trigger.
//   - Portal content intercepts click/contextmenu bubbling so item interactions never reach
//     ancestor onClick handlers (Radix renders content via Portal to document.body, but React
//     synthetic events still bubble through the React tree — see PLAN §1.7).

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      // Intercept click/contextmenu bubbling ONCE at the content level so every item is covered
      // without each item needing its own stopPropagation. Placed before {...props} so a caller
      // can still override if needed (PLAN §1.7 recommended approach).
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className={cn(
        'z-50 min-w-[160px] bg-[var(--color-surface)] rounded-lg shadow-linear-lg border border-[var(--color-border)] p-1 animate-slide-up',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    destructive?: boolean
    disabled?: boolean
    shortcut?: string
  }
>(({ className, destructive, shortcut, children, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer select-none outline-none transition-colors',
      // Radix sets data-disabled on the item when `disabled` is true, but does NOT grey it out
      // visually — these data-[disabled] selectors provide the "置灰" appearance (PLAN §1.2/B4).
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[disabled]:cursor-default',
      destructive
        ? 'text-[var(--color-danger)] hover:bg-red-50 focus:bg-red-50'
        : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-overlay)] focus:bg-[var(--color-surface-overlay)]',
      className,
    )}
    {...props}
  >
    {children}
    {shortcut && (
      <span className="ml-auto text-xs text-[var(--color-text-tertiary)]" aria-hidden="true">
        {shortcut}
      </span>
    )}
  </ContextMenuPrimitive.Item>
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn('my-1 h-px bg-[var(--color-border)]', className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      'relative flex items-center gap-2 pl-7 pr-2 py-1.5 text-sm rounded cursor-pointer select-none outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[disabled]:cursor-default',
      'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-overlay)] focus:bg-[var(--color-surface-overlay)]',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex items-center justify-center w-3.5">
      <ContextMenuPrimitive.ItemIndicator>
        <span className="text-accent text-xs">✓</span>
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
))
ContextMenuCheckboxItem.displayName = ContextMenuPrimitive.CheckboxItem.displayName

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
}
