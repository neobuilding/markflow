import { useEffect, useRef, useState, type RefObject } from 'react'

// Priority+ toolbar overflow (the pattern VS Code / Fluent / Radix-style navigation menus use):
// show as many commands as fit, and move the rest into a single "More" menu ONE AT A TIME as the
// container narrows. Commands are ordered by descending priority, so the leftmost (most used)
// actions survive the longest and the rightmost ones are the first to overflow.
//
// Follows VS Code's responsive toolbar (`src/vs/base/browser/ui/toolbar/toolbar.ts`): ONE
// ResizeObserver on the container, a fixed per-command budget in `kind: 'all'` mode, hiding from
// the array's end (`overflowFrom: 'end'`), and no debounce / binary search / hysteresis. VS Code
// also reads a single item's `clientWidth` in its `kind: 'last'` mode — that is a synchronous
// layout read inside the container callback, NOT a per-item observer, so it does not create a
// measure/render loop; the price is that an item changing its own size needs an explicit relayout.
// This repo keeps the fixed budget because every command is the same 32px icon tile and jsdom has
// no layout at all. The CONTAINER width is always a real measurement, never a guessed viewport.

/** A toolbar icon tile (32px) plus the 4px gap between tiles. */
export const ITEM_SLOT = 36
/** The "…" trigger occupies exactly ONE command slot — the same 36px tile as any other command. */
export const MORE_SLOT = 36
/** `px-3` padding (12px on each side), shared by both pane bars. */
export const BAR_PADDING = 24
/** Editor pane bar only: the format-group border + the find/replace divider. */
export const EDITOR_SEPARATORS = 16
/** Editor pane bar chrome. Bars without separators pass `BAR_PADDING` instead. */
export const EDITOR_BAR_CHROME = BAR_PADDING + EDITOR_SEPARATORS
/** How many commands the editor pane bar carries. */
export const EDITOR_COMMAND_COUNT = 12

/**
 * Column width at which every command of a `total`-command bar fits inline.
 *
 * `chrome` is REQUIRED on every function of this module that counts slots: a bar must state its own
 * padding/separator budget. A default here would let a future bar silently inherit the editor bar's
 * chrome and repeat the 16px-too-early overflow bug this parameter exists to prevent.
 */
export function allInlineWidth(total: number, chrome: number): number {
  return total * ITEM_SLOT + chrome
}

/**
 * The editor pane bar has 12 commands. This is the column width at which all of them fit inline;
 * the named e2e environments (`e2e/guards/viewports.test.ts`) derive their contract from it.
 *
 * DERIVED, not hand-written: the threshold must move WITH the budget, so the two can never
 * disagree about where "all inline" begins.
 */
export const ALL_INLINE_AT = allInlineWidth(EDITOR_COMMAND_COUNT, EDITOR_BAR_CHROME)

/**
 * How many leading commands fit inline at this column width. Above the all-inline width there is
 * no "…" trigger at all; below it the trigger must be paid for before any command slot is counted.
 * `chrome` is REQUIRED — see `allInlineWidth`.
 *
 * The last step restores TWO commands at once: `total - 1` inline commands plus the trigger occupy
 * exactly the width of `total` inline commands (the trigger IS one tile slot), so that state has
 * no width of its own. VS Code behaves the same way — it removes "…" as soon as the last hidden
 * action is restored — and adds no artificial hysteresis. See priority-overflow.test.ts.
 */
export function visibleCommandCount(width: number, total: number, chrome: number): number {
  if (width >= allInlineWidth(total, chrome)) return total
  const available = width - chrome - MORE_SLOT
  // `Math.min(total, …)` was unreachable: below the all-inline width the trigger's own slot
  // already caps the result at `total - 2`. CONTRIBUTING.md forbids unreachable dead code.
  return Math.max(0, Math.floor(available / ITEM_SLOT))
}

/**
 * Observe the bar's BORDER box (which equals the column width it fills) and report how many
 * commands fit. `null` before the first ResizeObserver callback means "fully expanded", which is
 * also the initial paint in a host without layout (jsdom). When the command count changes
 * (e.g. the export button appearing with the preview), the count is recomputed from the last
 * measured width without a new observation.
 *
 * `chrome` is REQUIRED — see `allInlineWidth`.
 */
export function usePriorityOverflow(
  ref: RefObject<HTMLElement | null>,
  total: number,
  chrome: number,
): number {
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    // docs/agents/testing.md, "Browser APIs jsdom does not implement": code must not assume an
    // optional browser API; a missing ResizeObserver degrades to the fully expanded first paint.
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const borderBox = entries[0]?.borderBoxSize as unknown as
        ReadonlyArray<{ inlineSize: number }> | undefined
      setWidth(borderBox?.[0]?.inlineSize ?? el.getBoundingClientRect().width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width === null ? total : visibleCommandCount(width, total, chrome)
}

/**
 * Keep keyboard focus reachable when a command is folded into the overflow trigger. VS Code's
 * responsive toolbar records `focusedAction` and rebuilds the roving tab stop so focus lands on
 * "…" (`toolbar.ts:577-578, 685-709`); React simply unmounts the focused button, which drops
 * focus to <body> (WCAG 2.4.3). `focusin` remembers the focused command index, so a shrinking
 * column can hand focus to the trigger and a widening column can put it back on the first command.
 *
 * Commands carry `data-command-index`, the trigger carries `data-overflow-trigger`.
 */
export function useOverflowFocus(
  barRef: RefObject<HTMLElement | null>,
  visible: number,
  total: number,
): void {
  const focusedIndex = useRef<number | null>(null)
  const triggerFocused = useRef(false)
  // The element that holds the focus inside the bar. Whether it is still CONNECTED tells two
  // situations apart: an overflow fold UNMOUNTS the focused command (the browser then drops focus
  // to <body> before React runs, so the focus must be handed to the "…" trigger), whereas a focus
  // that was genuinely lost (a click on a non-focusable part of the editor pane) leaves the
  // element in the DOM. Only the first case may re-home the focus — the second must never pull
  // the caret out of the editor pane.
  const focusedEl = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target as HTMLElement | null
      const raw = el?.getAttribute('data-command-index')
      focusedIndex.current = raw === null || raw === undefined ? null : Number(raw)
      triggerFocused.current = el?.hasAttribute('data-overflow-trigger') ?? false
      focusedEl.current = el
    }
    // The focus left the bar ON PURPOSE (tab, or a click into the editor pane): forget it, so a
    // later width change cannot yank the caret back into the toolbar.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as HTMLElement | null
      if (next !== null && !bar.contains(next)) {
        focusedIndex.current = null
        triggerFocused.current = false
        focusedEl.current = null
      }
    }
    bar.addEventListener('focusin', onFocusIn)
    bar.addEventListener('focusout', onFocusOut)
    return () => {
      bar.removeEventListener('focusin', onFocusIn)
      bar.removeEventListener('focusout', onFocusOut)
    }
  }, [barRef])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const el = focusedEl.current
    // The focused command is STILL in the DOM → it was not folded, so there is nothing to
    // re-home. This is also what keeps a genuinely dropped focus (the element stays, the focus
    // does not) from being reclaimed by a later width change.
    if (el !== null && el.isConnected) return
    // `focusedIndex` outlives the command set: a bar whose command COUNT changes (the preview bar
    // gains/loses commands with the preview's visibility) can still remember an index that no
    // longer exists. Such an index must never drive a hand-off — with `total` shrunk it would
    // otherwise pass the `>= visible` test and steal the caret back into the toolbar. The
    // remembered command is also only re-homed while a target actually exists: `visible < total`
    // guarantees the trigger is rendered, `visible >= total` the first inline command.
    const tracked = focusedIndex.current
    const triggerTarget =
      tracked !== null && tracked < total && tracked >= visible && visible < total
        ? bar.querySelector<HTMLElement>('[data-overflow-trigger]')
        : null
    const inlineTarget =
      triggerTarget === null && triggerFocused.current && visible >= total
        ? bar.querySelector<HTMLElement>('button[data-command-index="0"]')
        : null
    const target = triggerTarget ?? inlineTarget
    if (target) target.focus()
    // A successful hand-off refreshes the refs through `focusin`. When there was no target, or
    // the target refused the focus (disabled matter), the refs would keep pointing at a detached
    // node — and every later resize would retry the hand-off from that stale memory.
    if (target === null || document.activeElement !== target) {
      focusedEl.current = null
      focusedIndex.current = null
      triggerFocused.current = false
    }
  }, [visible, total, barRef])
}
