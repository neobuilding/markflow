import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Dialog, DialogContent } from '../components/ui/dialog'
import {
  hasModalSurface,
  isEditableTarget,
  isFindWidgetField,
  MODAL_SURFACE_SELECTOR,
} from './shortcut-scope'

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

// `isEditableTarget` decides whether a window-level shortcut may act on the document. It is the
// guard behind Ctrl/Cmd+B (Bold): a shortcut that MODIFIES the document must not fire while the
// user is typing in ANY field.
describe('isEditableTarget', () => {
  it('treats a missing or non-element active element as "not editing"', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(document.createTextNode('x') as unknown as Element)).toBe(false)
  })

  it('treats an input and a textarea as text-entry fields', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
  })

  it('treats the find widget inputs as text-entry fields as well', () => {
    // The find & replace widget's inputs live inside a CodeMirror panel. They are text fields, so
    // a shortcut that modifies the document (Ctrl/Cmd+B) must stand down there too — the panel
    // exemption belongs to the FIND / REPLACE shortcuts only (see isFindWidgetField).
    const panel = document.createElement('div')
    panel.className = 'cm-panel'
    const input = document.createElement('input')
    panel.appendChild(input)
    expect(isEditableTarget(input)).toBe(true)
  })

  it('treats a contenteditable surface as text-entry, except the editor content', () => {
    // jsdom does not implement `isContentEditable`, so it is defined explicitly here.
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isEditableTarget(editable)).toBe(true)

    const cmContent = document.createElement('div')
    cmContent.className = 'cm-content'
    Object.defineProperty(cmContent, 'isContentEditable', { value: true })
    expect(isEditableTarget(cmContent)).toBe(false)
  })

  it('treats a plain element as not editing', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
  })
})

// `isFindWidgetField` is the narrow exemption the find & replace widget's inputs get: Ctrl/Cmd+F
// and Ctrl/Cmd+H must keep working while that widget holds focus, because focus sits in its input
// the moment the panel opens.
describe('isFindWidgetField', () => {
  it('is false for a missing element and for a field outside a CodeMirror panel', () => {
    expect(isFindWidgetField(null)).toBe(false)
    expect(isFindWidgetField(document.createElement('input'))).toBe(false)
  })

  it('is true for a field inside a CodeMirror panel', () => {
    const panel = document.createElement('div')
    panel.className = 'cm-panel'
    const input = document.createElement('input')
    panel.appendChild(input)
    expect(isFindWidgetField(input)).toBe(true)
  })
})
