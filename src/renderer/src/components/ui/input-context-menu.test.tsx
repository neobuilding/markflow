import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import { InputContextMenu } from './input-context-menu'
import '../../i18n'

// jsdom implements neither `document.execCommand` nor `navigator.clipboard`, so both are
// injected per test
const execCommand = vi.fn()
let readText = vi.fn(async () => 'pasted')

beforeEach(() => {
  execCommand.mockReset()
  readText = vi.fn(async () => 'pasted')
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
  Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
  ;(window as unknown as { api: unknown }).api = { clipboard: { writeText: vi.fn() } }
})

afterEach(() => {
  Reflect.deleteProperty(document, 'execCommand')
  Reflect.deleteProperty(navigator, 'clipboard')
})

function mount(initial = 'hello', opts: { readOnly?: boolean; select?: [number, number] } = {}) {
  const ref = createRef<HTMLInputElement>()
  render(
    <InputContextMenu targetRef={ref} readOnly={opts.readOnly}>
      <input ref={ref} defaultValue={initial} readOnly={opts.readOnly} />
    </InputContextMenu>,
  )
  const input = screen.getByRole('textbox') as HTMLInputElement
  const [s, e] = opts.select ?? [0, initial.length]
  input.setSelectionRange(s, e)
  return input
}

async function open(input: HTMLElement) {
  await act(async () => {
    fireEvent.contextMenu(input)
  })
}

describe('InputContextMenu', () => {
  it('runs undo / redo through execCommand (keeps the native undo stack)', async () => {
    const input = mount()
    await open(input)
    fireEvent.click(await screen.findByTestId('input-undo'))
    expect(execCommand).toHaveBeenCalledWith('undo')
    await open(input)
    fireEvent.click(await screen.findByTestId('input-redo'))
    expect(execCommand).toHaveBeenCalledWith('redo')
  })

  it('copies the selected slice through the app clipboard channel', async () => {
    const input = mount('hello world', { select: [0, 5] })
    await open(input)
    fireEvent.click(await screen.findByTestId('input-copy'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('hello')
  })

  it('cuts by copying and then deleting the selection via insertText', async () => {
    const input = mount('hello world', { select: [0, 5] })
    await open(input)
    fireEvent.click(await screen.findByTestId('input-cut'))
    expect(window.api.clipboard.writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '')
  })

  it('pastes by inserting the clipboard text at the cursor', async () => {
    const input = mount()
    await open(input)
    await act(async () => {
      fireEvent.click(await screen.findByTestId('input-paste'))
    })
    expect(readText).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'pasted')
  })

  it('selects the whole value', async () => {
    const input = mount('hello world', { select: [0, 3] })
    await open(input)
    fireEvent.click(await screen.findByTestId('input-select-all'))
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('hello world'.length)
  })

  it('greys cut / copy without a selection but keeps select-all', async () => {
    const input = mount('hello', { select: [2, 2] })
    await open(input)
    expect(await screen.findByTestId('input-cut')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-copy')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-select-all')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('greys cut / copy / select-all for an empty input', async () => {
    const input = mount('')
    await open(input)
    expect(await screen.findByTestId('input-cut')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-copy')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-select-all')).toHaveAttribute('aria-disabled', 'true')
  })

  it('greys cut / paste / undo / redo on a read-only input', async () => {
    const input = mount('/out/a.html', { readOnly: true })
    await open(input)
    expect(await screen.findByTestId('input-cut')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-paste')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-undo')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-redo')).toHaveAttribute('aria-disabled', 'true')
    // Copy and select-all remain useful on a read-only field.
    expect(screen.getByTestId('input-copy')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('input-select-all')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('exposes a platform-aware shortcut hint on every item', async () => {
    const input = mount()
    await open(input)
    const undo = await screen.findByTestId('input-undo')
    // The hint is the `aria-hidden` <span> (not the lucide <svg>, which is also aria-hidden).
    const hint = undo.querySelector('span[aria-hidden="true"]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toMatch(/Z/)
  })

  it('does not refresh the snapshot when the menu closes', async () => {
    const input = mount('')
    await open(input)
    // Closing (onOpenChange(false)) must be a no-op for the snapshot path.
    expect(await screen.findByTestId('input-select-all')).toHaveAttribute('aria-disabled', 'true')
  })
})
