// 同步滚动控制器：在拆分视图（split）下，让源码窗格与预览窗格的滚动位置
// 保持同步。两侧内容高度不同，因此采用“滚动比例”算法：
//   目标滚动比例 = 源滚动比例（已滚动量 / 可滚动总量）
// 这样无论两侧内容高度差异多大，都能保持视觉位置基本一致。
//
// 耦合防护：当程序化地设置某一侧的 scrollTop 时，会触发该侧的 scroll 事件
// （即“回声”）。我们用一个锁标记 syncedPane 记录“刚刚被程序化滚动的那一侧”，
// 该侧的回声事件到来时直接忽略并解锁，从而避免无限回滚 / 抖动。
// 同时用一个短延时兜底清理锁，防止某些情况下回声事件未触发导致锁永久不释放。

export type PaneId = 'editor' | 'preview'

class ScrollSyncController {
  private elements: Partial<Record<PaneId, HTMLElement>> = {}
  private handlers: Partial<Record<PaneId, () => void>> = {}
  private syncedPane: PaneId | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null

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

  private handleScroll(id: PaneId): void {
    // 这是“回声”事件：刚刚由我们程序化滚动触发，忽略并解锁
    if (this.syncedPane === id) {
      this.clearLock()
      return
    }

    const src = this.elements[id]
    const destId: PaneId = id === 'editor' ? 'preview' : 'editor'
    const dest = this.elements[destId]
    if (!src || !dest) return

    const srcMax = src.scrollHeight - src.clientHeight
    const destMax = dest.scrollHeight - dest.clientHeight
    if (srcMax <= 0 || destMax <= 0) return

    const ratio = src.scrollTop / srcMax
    this.syncedPane = destId
    dest.scrollTop = ratio * destMax

    // 兜底：若某些情况下回声事件未触发，延时后强制解锁
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => this.clearLock(), 80)
  }
}

export const scrollSync = new ScrollSyncController()
