import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './dropdown-menu'

afterEach(() => cleanup())

describe('DropdownMenu (Radix wrapper)', () => {
  it('renders the trigger and opens content when controlled open', async () => {
    render(
      <DropdownMenu open={true}>
        <DropdownMenuTrigger data-testid="trigger">Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem data-testid="item">Action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(screen.getByTestId('trigger')).toBeInTheDocument()
    expect(await screen.findByTestId('item')).toBeInTheDocument()
  })

  it('applies the destructive variant class to items', async () => {
    render(
      <DropdownMenu open={true}>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem destructive data-testid="danger">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await waitFor(() => {
      expect(document.querySelector('.text-\\[var\\(--color-danger\\)\\]')).not.toBeNull()
    })
  })

  it('renders a separator', async () => {
    render(
      <DropdownMenu open={true}>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSeparator data-testid="sep" />
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(await screen.findByTestId('sep')).toBeInTheDocument()
  })
})
