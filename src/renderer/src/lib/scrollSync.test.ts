import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { scrollSync } from './scrollSync'

// jsdom doesn't implement layout: scrollTop/scrollHeight/clientHeight all default
// to 0. We use a plain EventTarget-backed fake element with ordinary properties
// for scrollTop/scrollHeight/clientHeight (overriding scrollTop on a real jsdom
// HTMLElement is unreliable because it is a native accessor). requestAnimationFrame
// is made synchronous so scheduleSync runs the sync fn immediately.
class FakePane extends EventTarget {
  scrollTop = 0
  scrollHeight = 1000
  clientHeight = 100
  constructor(opts: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}) {
    super()
    if (opts.scrollTop !== undefined) this.scrollTop = opts.scrollTop
    if (opts.scrollHeight !== undefined) this.scrollHeight = opts.scrollHeight
    if (opts.clientHeight !== undefined) this.clientHeight = opts.clientHeight
  }
}

describe('scrollSync — registration', () => {
  afterEach(() => {
    scrollSync.unregister('editor')
    scrollSync.unregister('preview')
    vi.restoreAllMocks()
  })

  it('registers both panes and ignores unknown ids gracefully', () => {
    const editor = new FakePane()
    const preview = new FakePane()
    expect(() => scrollSync.register('editor', editor as unknown as HTMLElement)).not.toThrow()
    expect(() => scrollSync.register('preview', preview as unknown as HTMLElement)).not.toThrow()
    expect(() =>
      scrollSync.register('editor' as never, editor as unknown as HTMLElement),
    ).not.toThrow()
  })

  it('re-registering an id removes the previous listener first', () => {
    const a = new FakePane()
    const b = new FakePane()
    scrollSync.register('editor', a as unknown as HTMLElement)
    scrollSync.register('editor', b as unknown as HTMLElement)
    expect(() => scrollSync.unregister('editor')).not.toThrow()
  })
})

describe('scrollSync — bidirectional ratio mapping', () => {
  let editor: FakePane
  let preview: FakePane

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    editor = new FakePane({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })
    preview = new FakePane({ scrollTop: 0, scrollHeight: 2000, clientHeight: 200 })
    scrollSync.register('editor', editor as unknown as HTMLElement)
    scrollSync.register('preview', preview as unknown as HTMLElement)
  })

  afterEach(() => {
    scrollSync.unregister('editor')
    scrollSync.unregister('preview')
    vi.restoreAllMocks()
  })

  it('syncs editor scroll ratio onto the preview pane', () => {
    editor.scrollTop = 450 // ratio = 450/900 = 0.5
    editor.dispatchEvent(new Event('scroll'))
    expect(preview.scrollTop).toBeCloseTo(900, 0)
  })

  it('snaps target to top when source is at the very top', () => {
    editor.scrollTop = 0
    editor.dispatchEvent(new Event('scroll'))
    expect(preview.scrollTop).toBe(0)
  })

  it('snaps target to bottom when source is at the very bottom', () => {
    editor.scrollTop = 900 // 900 + 100 >= 1000 - 1
    editor.dispatchEvent(new Event('scroll'))
    expect(preview.scrollTop).toBe(2000 - 200)
  })

  it('realign re-projects the last source pane ratio', () => {
    editor.scrollTop = 450
    editor.dispatchEvent(new Event('scroll'))
    preview.scrollHeight = 4000 // height jumped (image load)
    scrollSync.realign()
    expect(preview.scrollTop).toBeCloseTo(0.5 * (4000 - 200), 0)
  })

  it('does nothing when a pane is missing during sync', () => {
    scrollSync.unregister('preview')
    editor.scrollTop = 450
    expect(() => editor.dispatchEvent(new Event('scroll'))).not.toThrow()
  })

  it('reverses direction when the preview is the scroll source', () => {
    preview.scrollTop = 900 // ratio = 900/1800 = 0.5
    preview.dispatchEvent(new Event('scroll'))
    expect(editor.scrollTop).toBeCloseTo(0.5 * (1000 - 100), 0)
  })
})

describe('scrollSync — echo guard', () => {
  afterEach(() => {
    scrollSync.unregister('editor')
    scrollSync.unregister('preview')
    vi.restoreAllMocks()
  })

  it('ignores a pane scroll that it itself triggered (echo)', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    const editor = new FakePane()
    const preview = new FakePane()
    scrollSync.register('editor', editor as unknown as HTMLElement)
    scrollSync.register('preview', preview as unknown as HTMLElement)
    preview.scrollTop = 900
    preview.dispatchEvent(new Event('scroll'))
    const before = editor.scrollTop
    preview.dispatchEvent(new Event('scroll'))
    expect(editor.scrollTop).toBe(before)
  })
})
