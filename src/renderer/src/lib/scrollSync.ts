// 同步滚动控制器：在拆分视图（split）下，让源码窗格与预览窗格的滚动位置
// 保持同步。采用「块 startLine/endLine 行号映射」（设计 §12.1），替代旧的比例算法
// —— 比例算法在代码/表格/图片密集时严重漂移，而行号映射几乎零成本（块契约自带）。
//
// 接线层（G1）：两侧注册时可额外提供访问器——
//   preview 侧：getBlocks() 返回当前 blocks[]（含 startLine/endLine/id）
//   editor  侧：getView()   返回 CM6 EditorView
// 旧调用 register(id, el) 仍向后兼容（不传 accessor）。
//
// 回声防护：程序化滚动某一侧时置 syncedPane 锁，该侧回声事件直接忽略（不在此解锁），
// 锁由 armClear 的 80ms 定时器释放，避免多次回声事件（smooth/分步布局）反向同步抖动。
import { EditorView } from '@codemirror/view'
import type { Block } from './markdownEngine'

export type PaneId = 'editor' | 'preview'

interface Accessor {
  getBlocks?: () => Block[]
  getView?: () => EditorView | null
}

class ScrollSyncController {
  private elements: Partial<Record<PaneId, HTMLElement>> = {}
  private handlers: Partial<Record<PaneId, () => void>> = {}
  private accessors: Partial<Record<PaneId, Accessor>> = {}
  private syncedPane: PaneId | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private rafId: number | null = null

  register(id: PaneId, el: HTMLElement, accessor?: Accessor): void {
    if (this.elements[id]) this.unregister(id)
    const handler = () => this.handleScroll(id)
    this.handlers[id] = handler
    this.accessors[id] = accessor ?? {}
    this.elements[id] = el
    el.addEventListener('scroll', handler, { passive: true })
  }

  unregister(id: PaneId): void {
    const el = this.elements[id]
    const handler = this.handlers[id]
    if (el && handler) el.removeEventListener('scroll', handler)
    delete this.elements[id]
    delete this.handlers[id]
    delete this.accessors[id]
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

  private handleScroll(id: PaneId): void {
    // 回声防护（改进）：程序化滚动触发的本窗格滚动事件直接忽略，
    // 锁由 armClear 的定时器释放，避免多次回声事件造成反向同步抖动。
    if (this.syncedPane === id) {
      return
    }
    // 若锁定的另一窗格（上一轮自动同步的目标），本窗格此刻滚动视为用户接管，
    // 清除旧锁后继续同步，消除 80ms 死区。
    if (this.syncedPane !== null) {
      this.clearLock()
    }

    const src = this.elements[id]
    const destId: PaneId = id === 'editor' ? 'preview' : 'editor'
    const dest = this.elements[destId]
    if (!src || !dest) return

    // 行号映射需要两侧访问器：编辑器提供 getView（读源码行号），预览提供 getBlocks（行号→块映射）。
    // 注意：绝不能只传目标侧 accessor（旧实现因此两侧均静默失效）。
    const view = this.accessors['editor']?.getView?.() ?? null
    const blocks = this.accessors['preview']?.getBlocks?.() ?? null
    if (!view || !blocks || blocks.length === 0) return

    this.scheduleSync(() => {
      if (id === 'editor') this.syncEditorToPreview(dest, view, blocks)
      else this.syncPreviewToEditor(view, blocks)
    })
  }

  // 编辑器 → 预览：取视口顶部行号，查块映射，滚动预览到对应块。
  private syncEditorToPreview(previewEl: HTMLElement, view: EditorView, blocks: Block[]): void {
    const blockInfo = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
    const topLine = view.state.doc.lineAt(blockInfo.from).number
    const target = blocks.find((b) => topLine >= b.startLine && topLine <= b.endLine)
    if (!target) return

    const el = previewEl.querySelector<HTMLElement>(`[data-block-id="${target.id}"]`)
    if (!el) return

    this.syncedPane = 'preview'
    el.scrollIntoView({ block: 'start' })
    this.armClear()
  }

  // 预览 → 编辑器：取视口顶部块，反推源码行号，滚动编辑器到对应行。
  // 用 getBoundingClientRect 判定顶部块（而非 offsetTop），避免 content-visibility:auto
  // 屏外块以 contain-intrinsic-size 估算高度导致 offsetTop 累积误差（§12.1 / R8 相关）。
  private syncPreviewToEditor(view: EditorView, blocks: Block[]): void {
    const previewEl = this.elements['preview']
    if (!previewEl) return

    const containerTop = previewEl.getBoundingClientRect().top
    const blockById = new Map(blocks.map((b) => [b.id, b]))
    const els = previewEl.querySelectorAll<HTMLElement>('[data-block-id]')

    let target: Block | null = null
    for (const el of els) {
      const b = blockById.get(el.dataset.blockId ?? '')
      if (!b) continue
      const rect = el.getBoundingClientRect()
      if (rect.top <= containerTop && rect.bottom > containerTop) {
        target = b
        break
      }
    }
    if (!target) {
      // 兜底：取第一个底部越过容器顶部的块（视口内最靠上的块）。
      for (const el of els) {
        const b = blockById.get(el.dataset.blockId ?? '')
        if (!b) continue
        if (el.getBoundingClientRect().bottom > containerTop) {
          target = b
          break
        }
      }
    }
    if (!target) return

    const lineNo = Math.max(1, Math.min(target.startLine, view.state.doc.lines))
    const line = view.state.doc.line(lineNo)
    this.syncedPane = 'editor'
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
    this.armClear()
  }

  private armClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => this.clearLock(), 80)
  }
}

export const scrollSync = new ScrollSyncController()
