import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './tooltip'

afterEach(() => cleanup())

describe('Tooltip (Radix wrapper)', () => {
  it('renders the trigger and the content when open (controlled)', async () => {
    render(
      <TooltipProvider>
        <Tooltip open={true}>
          <TooltipTrigger data-testid="trigger">Hover</TooltipTrigger>
          <TooltipContent data-testid="content">Helpful hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    expect(screen.getByTestId('trigger')).toBeInTheDocument()
    expect(await screen.findByTestId('content')).toBeInTheDocument()
  })

  it('applies the merged className to the content', async () => {
    render(
      <TooltipProvider>
        <Tooltip open={true}>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent className="my-tip">Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    await waitFor(() => {
      expect(document.querySelector('.my-tip')).not.toBeNull()
    })
  })
})
