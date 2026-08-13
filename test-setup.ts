// Register jest-dom custom matchers (toBeInTheDocument, toHaveClass, ...) for
// React Testing Library assertions in *.test.tsx component suites.
import '@testing-library/jest-dom/vitest'

// React Testing Library does not auto-unmount between tests unless Vitest's
// global `afterEach` is in scope. This project keeps `globals` off for the
// main-process suites, so register cleanup explicitly to avoid DOM from one
// test leaking into the next (which would otherwise accumulate duplicate
// elements and break `getBy*` queries).
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

// Global test setup for jsdom environment.
//
// CodeMirror's `@codemirror/view` measures text layout by calling
// `Range.prototype.getClientRects()` / `getBoundingClientRect()` inside a
// requestAnimationFrame callback. jsdom does not implement these methods on
// `Range`, so every editor test throws an unhandled
// `TypeError: textRange(...).getClientRects is not a function`. That error is
// async (fired from the rAF queue) and does not affect test assertions, but it
// pollutes the run with "Unhandled Errors". Polyfill them here so the editor
// can measure layout without crashing under jsdom.

if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  // Return an empty DOMRectList-like iterable so CodeMirror's layout
  // measurement short-circuits (no measurable text) instead of throwing.
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    const list = [] as unknown as DOMRectList
    return list
  }

  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON() {
        return {}
      },
    } as DOMRect
  }
}

// Radix UI primitives (Dialog / DropdownMenu / Tooltip) call pointer-capture and
// scroll-into-view APIs that jsdom does not implement. Polyfill them so the
// component suites can render / open these primitives without throwing.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
}
