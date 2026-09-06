import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
} from './context-menu'

afterEach(() => cleanup())

describe('ContextMenu (Radix wrapper)', () => {
  it('renders the trigger and shows content when controlled open', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger data-testid="trigger">Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="item">Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    expect(screen.getByTestId('trigger')).toBeInTheDocument()
    expect(await screen.findByTestId('item')).toBeInTheDocument()
  })

  it('applies the destructive variant class to items', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem destructive data-testid="danger">
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    await waitFor(() => {
      expect(document.querySelector('.text-\\[var\\(--color-danger\\)\\]')).not.toBeNull()
    })
  })

  it('applies the non-destructive variant class to regular items', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="normal">Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    await waitFor(() => {
      expect(document.querySelector('.text-\\[var\\(--color-text-primary\\)\\]')).not.toBeNull()
    })
  })

  it('renders a separator', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSeparator data-testid="sep" />
        </ContextMenuContent>
      </ContextMenu>,
    )
    expect(await screen.findByTestId('sep')).toBeInTheDocument()
  })

  it('renders a shortcut label marked aria-hidden', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem shortcut="Ctrl+S" data-testid="save">
            Save
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const item = await screen.findByTestId('save')
    const hint = item.querySelector('[aria-hidden="true"]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toBe('Ctrl+S')
  })

  it('does not render a shortcut label when shortcut is omitted', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="plain">Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const item = await screen.findByTestId('plain')
    expect(item.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('renders a checkbox item with a check indicator when checked', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem data-testid="cb" checked onCheckedChange={vi.fn()}>
            Editor
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const cb = await screen.findByTestId('cb')
    expect(cb).toBeInTheDocument()
    // The ItemIndicator renders a ✓ when checked.
    expect(cb.querySelector('span.text-accent')?.textContent).toBe('✓')
  })

  it('renders a checkbox item without a check indicator when unchecked', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            data-testid="cb-unchecked"
            checked={false}
            onCheckedChange={vi.fn()}
          >
            Preview
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const cb = await screen.findByTestId('cb-unchecked')
    // No ItemIndicator rendered when unchecked.
    expect(cb.querySelector('span.text-accent')).toBeNull()
  })

  it('exposes role="menu" and role="menuitem"', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="item">Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem')).toBeInTheDocument()
  })

  it('closes when clicking outside the menu (pointerdown outside)', async () => {
    const onOpenChange = vi.fn()
    render(
      <ContextMenu open onOpenChange={onOpenChange}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="item">Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    await screen.findByTestId('item')
    // pointerdown outside the menu → Radix DismissableLayer fires onOpenChange(false).
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('closes on Escape', async () => {
    const onOpenChange = vi.fn()
    render(
      <ContextMenu open onOpenChange={onOpenChange}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="item">Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('stops click propagation so item clicks do not reach ancestor onClick', async () => {
    const ancestorClick = vi.fn()
    render(
      <div onClick={ancestorClick}>
        <ContextMenu open onOpenChange={vi.fn()}>
          <ContextMenuTrigger data-testid="trigger">Target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem data-testid="item" onClick={vi.fn()}>
              Action
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>,
    )
    const item = await screen.findByTestId('item')
    fireEvent.click(item)
    // The Content's onClick stopPropagation prevents the synthetic event from reaching
    // the ancestor <div onClick>. (PLAN §1.7 — Portal event bubpling trap.)
    expect(ancestorClick).not.toHaveBeenCalled()
  })

  it('stops contextmenu propagation on the content', async () => {
    const ancestorContextMenu = vi.fn()
    render(
      <div onContextMenu={ancestorContextMenu}>
        <ContextMenu open onOpenChange={vi.fn()}>
          <ContextMenuTrigger data-testid="trigger">Target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem data-testid="item">Action</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>,
    )
    const content = await screen.findByRole('menu')
    fireEvent.contextMenu(content)
    expect(ancestorContextMenu).not.toHaveBeenCalled()
  })

  it('supports a custom className on the content', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent className="custom-wide" data-testid="content">
          <ContextMenuItem>Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const content = await screen.findByTestId('content')
    expect(content.classList.contains('custom-wide')).toBe(true)
  })

  it('greys out a disabled item via data-[disabled] (PLAN §1.2/B4)', async () => {
    render(
      <ContextMenu open onOpenChange={vi.fn()}>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem data-testid="off" disabled>
            Locked
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    )
    const item = await screen.findByTestId('off')
    // Radix renders aria-disabled + data-disabled (not the HTML disabled attr);
    // the data-[disabled] selectors apply the greyed-out appearance.
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item.getAttribute('data-disabled')).not.toBeNull()
    expect(item.className).toContain('opacity-40')
  })
})
