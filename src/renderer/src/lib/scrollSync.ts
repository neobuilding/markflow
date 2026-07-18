// 同步滚动控制器：在拆分视图（split）下，让源码窗格与预览窗格的滚动位置保持同步。
//
// 双向比例映射：两侧都用 `ratio = src.scrollTop / (src.scrollHeight - src.clientHeight)`
// 对齐到对侧的绝对 scrollTop。比例映射天然连续、无跳变，免疫块密度不均 /
// mermaid 异步渲染 / content-visibility 等导致的高度跳变（本方案 mermaid 已在注入前
// 烘焙完整，更无异步增长）。行业通用方案（VS Code / Typora / Obsidian 均采用比例）。
//
// 回声防护：程序化滚动某一侧时置 syncedPane 锁，该侧回声事件直接忽略（不在此解锁），
// 锁由 armClear 的定时器（80ms）释放，避免多次回声事件反向同步抖动。

export type PaneId = 'editor' | 'preview'

class ScrollSyncController {
  private elements: Partial<Record<PaneId, HTMLElement>> = {}
  private handlers: Partial<Record<PaneId, () => void>> = {}
  private syncedPane: PaneId | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private rafId: number | null = null

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

    // 边界对齐：源侧到顶/到底时，目标侧直接对齐到顶/底。
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
    // 回声防护：程序化滚动触发的本窗格滚动事件直接忽略，
    // 锁由 armClear 的定时器释放，避免多次回声事件造成反向同步抖动。
    if (this.syncedPane === id) return
    // 若锁定的另一窗格（上一轮自动同步的目标），本窗格此刻滚动视为用户接管，
    // 清除旧锁后继续同步，消除 80ms 死区。
    if (this.syncedPane !== null) this.clearLock()

    const destId: PaneId = id === 'editor' ? 'preview' : 'editor'
    this.scheduleSync(() => this.sync(id, destId))
  }

  private armClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => this.clearLock(), 80)
  }
}

export const scrollSync = new ScrollSyncController()
