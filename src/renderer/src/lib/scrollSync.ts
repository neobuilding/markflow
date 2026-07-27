// Scroll-sync controller: keeps the source pane and preview pane scroll positions
// aligned in the split view.
//
// Bidirectional ratio mapping: both sides use `ratio = src.scrollTop /
// (src.scrollHeight - src.clientHeight)` projected onto the other side's absolute
// scrollTop. Ratio mapping is inherently continuous and jump-free, and is immune to
// height jumps from uneven block density / async mermaid rendering / content-visibility
// (in this design mermaid is baked fully before injection, so there is no async growth).
// This is the industry-standard approach (used by VS Code / Typora / Obsidian).
//
// Echo guard: when one side is scrolled programmatically we set the syncedPane lock and
// that side's echo scroll event is ignored (it is not released here); the lock is cleared
// by armClear's timer (80ms) to avoid reverse-sync jitter from repeated echo events.

export type PaneId = 'editor' | 'preview'

class ScrollSyncController {
  private elements: Partial<Record<PaneId, HTMLElement>> = {}
  private handlers: Partial<Record<PaneId, () => void>> = {}
  private syncedPane: PaneId | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private rafId: number | null = null
  // The pane that most recently acted as the "scroll source": after async image
  // loads change the preview height, the other side is re-aligned from this.
  private lastSource: PaneId = 'editor'

  register(id: PaneId, el: HTMLElement): void {
    if (this.elements[id]) this.unregister(id)
    const handler = () => this.handleScroll(id)
    this.handlers[id] = handler
    this.elements[id] = el
    el.addEventListener('scroll', handler, { passive: true })
  }

  unregister(id: PaneId): void {
    const el = this.elements[id]
    const handler = this.handlers[id]
    if (el && handler) el.removeEventListener('scroll', handler)
    delete this.elements[id]
    delete this.handlers[id]
    if (this.syncedPane === id) this.clearLock()
  }

  private clearLock(): void {
    this.syncedPane = null
    if (this.clearTimer) {
      clearTimeout(this.clearTimer)
      this.clearTimer = null
    }
  }

  private scheduleSync(fn: () => void): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      fn()
    })
  }

  private sync(srcId: PaneId, destId: PaneId): void {
    const src = this.elements[srcId]
    const dest = this.elements[destId]
    if (!src || !dest) return

    // Edge alignment: when the source hits top/bottom, snap the target to top/bottom.
    if (src.scrollTop <= 0) {
      this.syncedPane = destId
      dest.scrollTop = 0
      this.armClear()
      return
    }
    if (src.scrollTop + src.clientHeight >= src.scrollHeight - 1) {
      this.syncedPane = destId
      dest.scrollTop = dest.scrollHeight - dest.clientHeight
      this.armClear()
      return
    }

    const srcMax = Math.max(1, src.scrollHeight - src.clientHeight)
    const ratio = src.scrollTop / srcMax
    const dstMax = Math.max(1, dest.scrollHeight - dest.clientHeight)
    this.syncedPane = destId
    dest.scrollTop = ratio * dstMax
    this.armClear()
  }

  private handleScroll(id: PaneId): void {
    // Echo guard: ignore this pane's own scroll event triggered by programmatic
    // scrolling; the lock is released by armClear's timer to avoid reverse-sync
    // jitter from repeated echo events.
    if (this.syncedPane === id) return
    // If the other pane was locked (the target of the previous auto-sync), treat this
    // pane's scroll as user takeover: clear the old lock and continue syncing, removing
    // the 80ms dead zone.
    if (this.syncedPane !== null) this.clearLock()

    // Record the scroll source for this turn (used by realign after image onload).
    this.lastSource = id
    const destId: PaneId = id === 'editor' ? 'preview' : 'editor'
    this.scheduleSync(() => this.sync(id, destId))
  }

  // After async image loads change the preview/editor height, recompute the other
  // side's ratio from the last scroll source to fix half-screen misalignment caused
  // by height jumps (Final Design §3.1 addendum).
  public realign(): void {
    if (!this.lastSource) return
    const dest: PaneId = this.lastSource === 'editor' ? 'preview' : 'editor'
    if (!this.elements[this.lastSource] || !this.elements[dest]) return
    const src = this.lastSource
    this.scheduleSync(() => this.sync(src, dest))
  }

  private armClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => this.clearLock(), 80)
  }
}

export const scrollSync = new ScrollSyncController()
