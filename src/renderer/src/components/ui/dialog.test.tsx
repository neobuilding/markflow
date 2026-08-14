import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from './dialog'

afterEach(() => cleanup())

describe('Dialog (Radix wrapper)', () => {
  it('does not render content when closed (controlled)', () => {
    render(
      <Dialog open={false}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hidden</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.queryByText('Hidden')).toBeNull()
  })

  it('renders content + title when open (controlled) and the close button', async () => {
    render(
      <Dialog open={true}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>My Dialog</DialogTitle>
          </DialogHeader>
          <DialogClose data-testid="close">Close</DialogClose>
        </DialogContent>
      </Dialog>,
    )
    expect(await screen.findByText('My Dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('close')).toBeInTheDocument()
  })

  it('applies merged className to the content', async () => {
    render(
      <Dialog open={true}>
        <DialogContent className="my-custom-content">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    await waitFor(() => {
      expect(document.querySelector('.my-custom-content')).not.toBeNull()
    })
  })
})
