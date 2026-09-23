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

// jsdom does not implement IntersectionObserver, but MarkdownPreview (D-E① lazy mermaid
// render) constructs one on mount. Without a polyfill, any component suite that mounts
// MarkdownPreview (e.g. EditorPane) throws "IntersectionObserver is not defined". Provide a
// mock that reports every observed element as immediately intersecting, so diagrams render
// synchronously under jsdom — matching the visibility assumption of the real renderer.
if (
  typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver === 'undefined'
) {
  class IntersectionObserverMock {
    private readonly cb: IntersectionObserverCallback
    // Mirror the real `IntersectionObserver` signature `(callback, options?)`. The
    // options are unused here (the mock reports every element as intersecting), but
    // declaring the parameter keeps this consistent with the global constructor that
    // production code calls with a second options argument.
    constructor(cb: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
      this.cb = cb
    }
    observe(el: Element): void {
      this.cb(
        [
          {
            isIntersecting: true,
            target: el,
            boundingClientRect: {} as DOMRect,
            intersectionRatio: 1,
            intersectionRect: {} as DOMRect,
            rootBounds: null,
            time: 0,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      )
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    IntersectionObserverMock
}

// The suite creates real temp dirs under %TEMP% (folder-watcher / open-folder / document
// / export fixtures). Vitest never cleans %TEMP%, so reclaim every path allocated through
// mkTestDir() when each test file finishes. Registering the hook in this setup file means
// it runs for every suite without editing each one, and it only removes dirs the suite
// itself recorded (no scan of %TEMP%, so it can never touch another process's data).
// NOTE: a process-level `exit` handler is unreliable under Vitest's worker/thread pool, so
// we use Vitest's own `afterAll` hook, which is guaranteed to fire per test file.
import { afterAll } from 'vitest'
import { cleanupTestDirs } from './electron/main/test-support/tmp'
afterAll(() => cleanupTestDirs())
