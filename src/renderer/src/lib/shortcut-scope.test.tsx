import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Dialog, DialogContent } from '../components/ui/dialog'
import { hasModalSurface, MODAL_SURFACE_SELECTOR } from './shortcut-scope'

describe('shortcut-scope', () => {
  it('finds no modal surface in an empty root', () => {
    const root = document.createElement('div')
    expect(hasModalSurface(root)).toBe(false)
  })

  it('treats a data-modal-surface element as owning the keyboard', () => {
    const root = document.createElement('div')
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-surface', '')
    root.appendChild(modal)
    expect(hasModalSurface(root)).toBe(true)
  })

  it('also honours the standard role="dialog"', () => {
    const root = document.createElement('div')
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    root.appendChild(modal)
    expect(hasModalSurface(root)).toBe(true)
  })

  it('finds a modal surface nested at any depth', () => {
    const root = document.createElement('div')
    const deep = document.createElement('div')
    const modal = document.createElement('span')
    modal.setAttribute('data-modal-surface', '')
    deep.appendChild(modal)
    root.appendChild(deep)
    expect(hasModalSurface(root)).toBe(true)
  })

  // Wiring test: if the shared dialog wrapper ever drops the marker, every other test here would
  // still pass (they build the DOM by hand) while global shortcuts would start firing behind
  // modals again. This is the only test that would catch it.
  it('marks real dialogs rendered through ui/dialog', () => {
    render(
      <Dialog open>
        <DialogContent>hello</DialogContent>
      </Dialog>,
    )
    expect(document.querySelector(MODAL_SURFACE_SELECTOR)).not.toBeNull()
    expect(hasModalSurface(document)).toBe(true)
  })
})
