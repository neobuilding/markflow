# ADR-0008: Right-click context menu architecture (Radix ContextMenu)

- **Status:** Accepted
- **Implemented:** 2026-09 (M0–M3, `PLAN-context-menus-2026-09.md`)

## Context

Right-click menus were faked with `@radix-ui/react-dropdown-menu` plus a manual
`onContextMenu` / `setMenuOpen(true)` hack. That produced three defects: the menu anchored to the `⋮`
button instead of the cursor (G3), a selection-loss risk (G4), and broken keyboard semantics (Enter/Space
instead of native Shift+F10).

## Decision

- **Right-click** uses `@radix-ui/react-context-menu` — it pops at the mouse coordinates and supports
  native Shift+F10. A dedicated `components/ui/context-menu.tsx` wraps it (`ContextMenu`,
  `ContextMenuTrigger`, `ContextMenuContent` via Portal, `ContextMenuItem` with `disabled`/`destructive`/
  `shortcut`, `ContextMenuCheckboxItem`), sharing the DropdownMenu CSS so the two look identical.
- **Button-triggered** menus keep `@radix-ui/react-dropdown-menu` (anchored to the button, `align="end"`).
  The DropdownMenu hack for right-click was fully migrated away (`setMenuOpen` → 0 hits).
- Radix renders menu content in a **Portal** on `document.body`; React synthetic events still bubble up
  the React tree, so every menu item calls `stopPropagation()` to avoid triggering the trigger element's
  ancestor `onClick` (e.g. opening a doc or closing the search palette).
- Test ids use the `ctx-*` prefix; shortcut text is rendered via `formatShortcut` (platform-aware), never
  a hardcoded `⌘`.

## Consequences

- **Positive:** correct cursor anchoring, safe selection, native keyboard support; one consistent
  right-click component; DropdownMenu no longer doubles as a right-click fake.
- **Negative:** two Radix primitives to maintain; the Portal-bubbling gotcha must be respected on every
  new menu item (missing `stopPropagation` silently fires ancestor handlers).
