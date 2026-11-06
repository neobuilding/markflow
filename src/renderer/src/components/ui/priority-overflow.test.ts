import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import {
  ALL_INLINE_AT,
  EDITOR_BAR_CHROME,
  BAR_PADDING,
  EDITOR_COMMAND_COUNT,
  EDITOR_SEPARATORS,
  ITEM_SLOT,
  MORE_SLOT,
  allInlineWidth,
  useOverflowFocus,
  usePriorityOverflow,
  visibleCommandCount,
} from './priority-overflow'

type ResizeCallback = (
  entries: Array<{
    borderBoxSize?: ReadonlyArray<{ inlineSize: number }>
    contentRect: { width: number }
  }>,
) => void
const observers: ResizeCallback[] = []
const instances: MockResizeObserver[] = []
class MockResizeObserver {
  disconnected = false
  constructor(cb: ResizeCallback) {
    observers.push(cb)
    instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
}
// docs/agents/testing.md:121 — a stubbed global must be restored afterwards.
const OriginalResizeObserver = globalThis.ResizeObserver

function makeRef() {
  return { current: document.createElement('div') }
}

function reportWidth(width: number, borderBoxSize = true) {
  act(() => {
    observers.forEach((cb) =>
      cb([
        {
          ...(borderBoxSize ? { borderBoxSize: [{ inlineSize: width }] } : {}),
          contentRect: { width },
        },
      ]),
    )
  })
}

beforeEach(() => {
  observers.length = 0
  instances.length = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
})
afterEach(() => {
  cleanup()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = OriginalResizeObserver
})

describe('visibleCommandCount (priority+)', () => {
  it('keeps every command inline once the all-inline width is reached', () => {
    expect(allInlineWidth(EDITOR_COMMAND_COUNT, EDITOR_BAR_CHROME)).toBe(ALL_INLINE_AT)
    expect(visibleCommandCount(ALL_INLINE_AT, 12, EDITOR_BAR_CHROME)).toBe(12)
    expect(visibleCommandCount(ALL_INLINE_AT + 500, 12, EDITOR_BAR_CHROME)).toBe(12)
  })

  it('visits every intermediate state instead of an all-or-nothing fold', () => {
    const counts = new Set<number>()
    for (let width = 0; width <= ALL_INLINE_AT; width += 1) {
      counts.add(visibleCommandCount(width, 12, EDITOR_BAR_CHROME))
    }
    for (let n = 0; n <= 10; n += 1) expect(counts.has(n)).toBe(true)
    expect(counts.has(12)).toBe(true)
    // 11 inline + the "…" trigger occupies exactly the same width as 12 inline commands
    // (the trigger IS one tile slot), so there is no width at which that state exists. The
    // last step simply drops both the trigger and the final overflow entry at once.
    expect(visibleCommandCount(ALL_INLINE_AT - 1, 12, EDITOR_BAR_CHROME)).toBe(10)
  })

  it('pays for the More trigger and never claims more slots than exist', () => {
    expect(
      visibleCommandCount(EDITOR_BAR_CHROME + MORE_SLOT + ITEM_SLOT - 1, 12, EDITOR_BAR_CHROME),
    ).toBe(0)
    expect(
      visibleCommandCount(EDITOR_BAR_CHROME + MORE_SLOT + ITEM_SLOT, 12, EDITOR_BAR_CHROME),
    ).toBe(1)
    expect(visibleCommandCount(0, 12, EDITOR_BAR_CHROME)).toBe(0)
    expect(visibleCommandCount(10_000, 0, EDITOR_BAR_CHROME)).toBe(0)
  })

  it('uses the bar-specific chrome instead of charging every bar for group separators', () => {
    expect(EDITOR_BAR_CHROME).toBe(BAR_PADDING + EDITOR_SEPARATORS)
    // The preview bar has no separators: 4 tiles + 24px padding = 168px, not 184px.
    expect(allInlineWidth(4, BAR_PADDING)).toBe(168)
    expect(visibleCommandCount(168, 4, BAR_PADDING)).toBe(4)
    // 168– 183px used to overflow two commands early with the editor bar's 40px chrome.
    expect(visibleCommandCount(183, 4, EDITOR_BAR_CHROME)).toBe(2)
    expect(visibleCommandCount(183, 4, BAR_PADDING)).toBe(4)
  })
})

describe('usePriorityOverflow', () => {
  it('starts fully expanded before the first measurement', () => {
    const ref = makeRef()
    const { result } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    expect(result.current).toBe(12)
  })

  it('reads the border box width reported by the observer', () => {
    const ref = makeRef()
    const { result } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    reportWidth(300)
    expect(result.current).toBe(visibleCommandCount(300, 12, EDITOR_BAR_CHROME))
  })

  it('falls back to getBoundingClientRect when borderBoxSize is unavailable', () => {
    const ref = makeRef()
    ref.current.getBoundingClientRect = () => ({ width: 300, height: 0 }) as unknown as DOMRect
    const { result } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    reportWidth(300, false)
    expect(result.current).toBe(visibleCommandCount(300, 12, EDITOR_BAR_CHROME))
  })

  it('recomputes from the last width when the command count changes', () => {
    const ref = makeRef()
    const { result, rerender } = renderHook(
      ({ total }) => usePriorityOverflow(ref, total, EDITOR_BAR_CHROME),
      {
        initialProps: { total: 12 },
      },
    )
    reportWidth(300)
    expect(result.current).toBe(visibleCommandCount(300, 12, EDITOR_BAR_CHROME))
    rerender({ total: 3 })
    expect(result.current).toBe(3)
  })

  it('does nothing when the ref is not attached yet', () => {
    const ref = { current: null }
    const { result } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    reportWidth(300)
    expect(observers).toHaveLength(0)
    expect(result.current).toBe(12)
  })

  it('degrades to fully expanded when the host has no ResizeObserver', () => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined
    const ref = makeRef()
    const { result } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    expect(observers).toHaveLength(0)
    expect(result.current).toBe(12)
  })

  it('falls back to the element width when borderBoxSize is an empty array', () => {
    const ref = makeRef()
    ref.current.getBoundingClientRect = () => ({ width: 200, height: 0 }) as unknown as DOMRect
    const { result } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    act(() => {
      observers.forEach((cb) => cb([{ borderBoxSize: [], contentRect: { width: 200 } }]))
    })
    expect(result.current).toBe(visibleCommandCount(200, 12, EDITOR_BAR_CHROME))
  })

  it('disconnects the observer on unmount', () => {
    const ref = makeRef()
    const { unmount } = renderHook(() => usePriorityOverflow(ref, 12, EDITOR_BAR_CHROME))
    expect(instances).toHaveLength(1)
    unmount()
    expect(instances[0].disconnected).toBe(true)
  })

  it('recomputes a partially overflowed count when the chrome budget changes', () => {
    const ref = makeRef()
    const { result, rerender } = renderHook(({ chrome }) => usePriorityOverflow(ref, 12, chrome), {
      initialProps: { chrome: EDITOR_BAR_CHROME },
    })
    // 276px: 40px chrome leaves 5 slots, 24px leaves 6. A width where the 16px difference
    // does NOT cross a slot boundary would make this assertion vacuous.
    const width = 276
    reportWidth(width)
    const withSeparators = result.current
    expect(withSeparators).toBe(visibleCommandCount(width, 12, EDITOR_BAR_CHROME))
    expect(withSeparators).toBeGreaterThan(0)
    expect(withSeparators).toBeLessThan(12)
    rerender({ chrome: BAR_PADDING })
    expect(result.current).toBe(visibleCommandCount(width, 12, BAR_PADDING))
    expect(result.current).toBeGreaterThan(withSeparators)
  })
})

describe('useOverflowFocus', () => {
  const mounted: HTMLElement[] = []
  function makeBar() {
    const bar = document.createElement('div')
    const first = document.createElement('button')
    first.setAttribute('data-command-index', '0')
    const folded = document.createElement('button')
    folded.setAttribute('data-command-index', '3')
    const trigger = document.createElement('button')
    trigger.setAttribute('data-overflow-trigger', '')
    bar.append(first, folded, trigger)
    document.body.appendChild(bar)
    mounted.push(bar)
    return { bar, first, folded, trigger }
  }
  // A failed assertion must not leak a bar into the next case (docs/agents/testing.md).
  afterEach(() => {
    for (const bar of mounted) bar.remove()
    mounted.length = 0
  })

  it('hands focus to the overflow trigger when the focused command is folded', () => {
    const { bar, folded, trigger } = makeBar()
    const ref = { current: bar }
    const { rerender } = renderHook(({ visible }) => useOverflowFocus(ref, visible, 4), {
      initialProps: { visible: 4 },
    })
    // focusin must happen AFTER the hook mounted its listener, as it does in the real bar.
    folded.focus()
    folded.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // Folding UNMOUNTS the focused command (React drops it from the tree) and the browser moves
    // the focus to <body> — the WCAG 2.4.3 hole the "…" trigger has to fill.
    folded.remove()
    rerender({ visible: 2 })
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the first inline command when the trigger disappears', () => {
    const { bar, first, trigger } = makeBar()
    const ref = { current: bar }
    const { rerender } = renderHook(({ visible }) => useOverflowFocus(ref, visible, 4), {
      initialProps: { visible: 2 },
    })
    trigger.focus()
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // Widening past the all-inline width removes the trigger from the tree.
    trigger.remove()
    rerender({ visible: 4 })
    expect(document.activeElement).toBe(first)
  })

  it('does not yank focus from outside the bar (e.g. the editor pane)', () => {
    const { bar, folded } = makeBar()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    // A STALE in-bar focus: focusedIndex is recorded, then the user moves to the editor pane,
    // so the live active element is no longer a bar descendant.
    folded.focus()
    folded.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    outside.focus()
    expect(bar.contains(document.activeElement)).toBe(false)
    const ref = { current: bar }
    const { rerender } = renderHook(({ visible }) => useOverflowFocus(ref, visible, 4), {
      initialProps: { visible: 4 },
    })
    rerender({ visible: 2 })
    // The folding must NOT pull the caret out of the editor and into the "…" trigger.
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('does not reclaim a focus that was genuinely dropped (the command stays in the DOM)', () => {
    const { bar, folded, trigger } = makeBar()
    const ref = { current: bar }
    const { rerender } = renderHook(({ visible }) => useOverflowFocus(ref, visible, 4), {
      initialProps: { visible: 4 },
    })
    folded.focus()
    folded.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // The focus is dropped WITHOUT leaving the bar (a click on a non-focusable part of the
    // editor pane): the command STAYS in the DOM, so the hook must not reclaim the focus — the
    // fold may not pull the caret into the toolbar.
    folded.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    folded.blur()
    expect(document.activeElement).not.toBe(folded)
    rerender({ visible: 2 })
    expect(document.activeElement).not.toBe(trigger)
  })

  it('ignores a remembered command index that no longer exists in the command set', () => {
    const { bar, folded, trigger } = makeBar()
    const ref = { current: bar }
    const { rerender } = renderHook(({ visible, total }) => useOverflowFocus(ref, visible, total), {
      initialProps: { visible: 4, total: 4 },
    })
    folded.focus()
    folded.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // The focus is dropped (no relatedTarget) while the command stays put, and then the command
    // SET shrinks — index 3 no longer exists, but the "…" trigger still does.
    folded.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    folded.blur()
    folded.remove()
    rerender({ visible: 2, total: 3 })
    // A remembered index outside the current command set must not drive a hand-off: it would
    // otherwise pass the `>= visible` test and steal the caret back into the toolbar.
    expect(document.activeElement).not.toBe(trigger)
  })
})
