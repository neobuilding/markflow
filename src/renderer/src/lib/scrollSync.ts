// 同步滚动控制器：在拆分视图（split）下，让源码窗格与预览窗格的滚动位置
// 保持同步。
//
// 方向策略（非对称）：
//   编辑器 → 预览：**比例映射**（scrollRatio）。两侧 scrollTop / maxScroll 比值对齐。
//     优势：天然连续、无跳变、免疫 content-visibility / mermaid 异步渲染 / 块密度不均
//     （视频证实：块内线性插值 f*h 在 mermaid 等低行数-高像素块处系统性失步：
//      编辑器滚过 mermaid 源码（~15 行）时预览须滚过整张图（~400px），预览「提前跳出→
//      卡住闪烁→等编辑滚走才跳下一个」。比例映射彻底消除此问题。）
//     代价：特定行号与预览渲染的精确像素对齐略有漂移（代码密集区明显），但滚动手感
//     平滑远优于块式跳跃；行业通用方案（VS Code / Typora / Obsidian 均采用比例）。
//
//   预览 → 编辑器：**块行号映射**（保留原设计 §12.1）。取预览顶部所在块，按像素进度
//     插值到编辑器行号，再用 coordsAtPos 定位亚行级像素位置。
//     此方向无密度不对称问题（预览像素 → 编辑器行号的映射由 coordsAtPos 兜底保证精度），
//     且需要 getBlocks() 提供的 startLine/endLine 信息。
//
// 接线层（G1）：两侧注册时可额外提供访问器——
//   preview 侧：getBlocks() 返回当前 blocks[]（含 startLine/endLine/id）
//   editor  侧：getView()   返回 CM6 EditorView
// 旧调用 register(id, el) 仍向后兼容（不传 accessor）。
//
// 回声防护：程序化滚动某一侧时置 syncedPane 锁，该侧回声事件直接忽略（不在此解锁），
// 锁由 armClear 的定时器释放，避免多次回声事件（smooth/分步布局）反向同步抖动。

import { EditorView } from '@codemirror/view'
import type { Block } from './markdownEngine'

export type PaneId = 'editor' | 'preview'

interface Accessor {
  getBlocks?: () => Block[]
  getView?: () => EditorView | null
}

interface PreviewLayout {
  top: Map<string, number>
  height: Map<string, number>
}

class ScrollSyncController {
  private elements: Partial<Record<PaneId, HTMLElement>> = {}
  private handlers: Partial<Record<PaneId, () => void>> = {}
  private accessors: Partial<Record<PaneId, Accessor>> = {}
  private syncedPane: PaneId | null = null
  private clearTimer: ReturnType<typeof setTimeout> | null = null
  private rafId: number | null = null

  // 预览块偏移缓存：仅用于「预览 → 编辑器」方向的块定位（取顶部块 + 像素→行插值）。
  // 「编辑器 → 预览」方向已改用比例映射，不需要此缓存。
  private previewLayout: PreviewLayout | null = null
  private lastBlocksRef: Block[] | null = null
  private layoutRO: ResizeObserver | null = null
  private layoutScheduled = false
  private resizeHandler: (() => void) | null = null

  // 比例映射分母缓存：编辑器→预览方向使用 previewMaxScroll = scrollHeight - clientHeight
  // 作为 dstMax。若在活跃滚动期间 mermaid/图片异步渲染导致 scrollHeight 阶跃增长，
  // 实时读取会使 ratio * dstMax 跳变 → 预览「颤抖」（首次经过 mermaid 特有现象，
  // 再次经过时内容已就绪故稳定）。解决：滚动空闲期刷新此缓存；滚动期间冻结使用
  // 缓存值，杜绝分母跳变。（误差有界且自校正：下次空闲期更新后即归位。）
  private cachedPreviewMaxScroll: number | null = null
  // 滚动活跃标记：最近一次 handleScroll 的时间戳。
  private lastScrollTime = 0

  register(id: PaneId, el: HTMLElement, accessor?: Accessor): void {
    if (this.elements[id]) this.unregister(id)
    const handler = () => this.handleScroll(id)
    this.handlers[id] = handler
    this.accessors[id] = accessor ?? {}
    this.elements[id] = el
    el.addEventListener('scroll', handler, { passive: true })

    if (id === 'preview') {
      // 监听块尺寸变化以更新偏移缓存（供预览→编辑器方向使用）。
      this.layoutRO = new ResizeObserver(() => this.scheduleLayoutRebuild())
      this.resizeHandler = () => this.scheduleLayoutRebuild()
      window.addEventListener('resize', this.resizeHandler)
      this.scheduleLayoutRebuild()
    }
  }

  unregister(id: PaneId): void {
    const el = this.elements[id]
    const handler = this.handlers[id]
    if (el && handler) el.removeEventListener('scroll', handler)
    delete this.elements[id]
    delete this.handlers[id]
    delete this.accessors[id]
    if (this.syncedPane === id) this.clearLock()

    if (id === 'preview') {
      if (this.layoutRO) {
        this.layoutRO.disconnect()
        this.layoutRO = null
      }
      if (this.resizeHandler) {
        window.removeEventListener('resize', this.resizeHandler)
        this.resizeHandler = null
      }
      this.previewLayout = null
      this.lastBlocksRef = null
    }
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

  // 构建预览块偏移缓存（供预览→编辑器用）。
  // 不再强制切换 content-visibility —— 仅读取 offsetTop/offsetHeight，
  // 屏外块返回 contain-intrinsic-size 记忆值（已可见过的块为真实尺寸）。
  // 对预览→编辑器方向而言，少量估值误差仅影响「顶部块识别」的粗定位，
  // 最终由 coordsAtPos 精确定位，故可接受。
  private buildPreviewLayout(previewEl: HTMLElement): void {
    const blocks = this.accessors['preview']?.getBlocks?.() ?? null
    if (!blocks || blocks.length === 0) {
      this.previewLayout = null
      this.lastBlocksRef = blocks
      return
    }
    const map = new Map(blocks.map((b) => [b.id, b]))
    const els = Array.from(previewEl.querySelectorAll<HTMLElement>('[data-block-id]'))
    if (els.length === 0) {
      this.previewLayout = null
      this.lastBlocksRef = blocks
      return
    }
    const top = new Map<string, number>()
    const height = new Map<string, number>()
    for (const el of els) {
      const bid = el.dataset.blockId
      if (!bid || !map.has(bid)) continue
      top.set(bid, el.offsetTop)
      height.set(bid, el.offsetHeight || 1)
    }
    this.previewLayout = { top, height }
    this.lastBlocksRef = blocks
    // 重新观察当前块（blocks 变化后元素可能已替换）。
    if (this.layoutRO) {
      this.layoutRO.disconnect()
      els.forEach((el) => this.layoutRO!.observe(el))
    }
  }

  // 内容/文档变化后主动重建偏移缓存。
  // 同时重置比例映射分母缓存（cachedPreviewMaxScroll）：切换/编辑文档后预览高度已变，
  // 下次滚动须用新 scrollHeight 刷新分母，否则沿用旧值会导致首次映射轻微偏位。
  refreshLayout(): void {
    this.cachedPreviewMaxScroll = null
    this.scheduleLayoutRebuild()
  }

  private scheduleLayoutRebuild(): void {
    if (this.layoutScheduled) return
    this.layoutScheduled = true
    requestAnimationFrame(() => {
      this.layoutScheduled = false
      const previewEl = this.elements['preview']
      if (previewEl) this.buildPreviewLayout(previewEl)
    })
  }

  // 确保偏移缓存可用（供预览→编辑器方向调用）。
  private ensureLayout(previewEl: HTMLElement, blocks: Block[]): boolean {
    if (!this.previewLayout || this.lastBlocksRef !== blocks) {
      this.buildPreviewLayout(previewEl)
    }
    return this.previewLayout !== null
  }

  private handleScroll(id: PaneId): void {
    // 记录活跃时间（供比例映射分母冻结逻辑使用）。
    this.lastScrollTime = performance.now()
    // 回声防护：程序化滚动触发的本窗格滚动事件直接忽略，
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

    // 预览→编辑器需要访问器获取块信息与 CM6 视图。
    const view = this.accessors['editor']?.getView?.() ?? null
    const blocks = this.accessors['preview']?.getBlocks?.() ?? null

    this.scheduleSync(() => {
      if (id === 'editor') this.syncEditorToPreview(dest as HTMLElement)
      else if (view && blocks && blocks.length > 0) this.syncPreviewToEditor(view, blocks)
    })
  }

  // ════════════════════════════════════════════════════════════════
  // 编辑器 → 预览：比例映射（scrollRatio）
  // ════════════════════════════════════════════════════════════════
  // 核心公式：previewScroll = (editorScroll / editorMaxScroll) * previewMaxScroll
  //
  // 为什么不用块行号映射（§12.1 原设计）？
  //   视频铁证：mermaid 块源码 ~15 行 → 渲染图 ~400px（27 px/行），周围正文 ~20 px/行。
  //   块内线性插值 f*h 在密度边界处系统性失步——编辑器滚入 mermaid 时预览暴进、
  //   滚出时滞后然后猛跳（「提前挑出→卡住闪烁→等滚走才跳下一个」）。
  //   此问题无法通过改善高度测量解决（是 f*h 模型本身的结构缺陷）。
  //
  // 比例映射的代价：代码密集区（编辑器很长 / 预览很短）会有漂移——用户在编辑器看第 80
  // 行代码时，预览可能显示的是对应段落的中间而非精确首行。但滚动过程完全平滑，
  //   行业标准行为（VS Code / Typora / Obsidian 均如此）。
  // ════════════════════════════════════════════════════════════════
  private syncEditorToPreview(previewEl: HTMLElement): void {
    // 边界对齐：源侧到顶/到底时，目标侧直接对齐到顶/底。
    const editorEl = this.elements['editor'] as HTMLElement | undefined
    if (!editorEl) return

    if (editorEl.scrollTop <= 0) {
      this.syncedPane = 'preview'
      previewEl.scrollTop = 0
      this.armClear()
      return
    }
    if (editorEl.scrollTop + editorEl.clientHeight >= editorEl.scrollHeight - 1) {
      this.syncedPane = 'preview'
      previewEl.scrollTop = previewEl.scrollHeight - previewEl.clientHeight
      this.armClear()
      return
    }

    // 比例映射核心。
    const srcMax = Math.max(1, editorEl.scrollHeight - editorEl.clientHeight)
    const ratio = editorEl.scrollTop / srcMax

    // 使用冻结的 dstMax（滚动空闲期刷新），避免 mermaid/图片异步渲染导致
    // scrollHeight 阶跃增长 → ratio * dstMax 跳变 → 预览颤抖。
    // 首次或缓存过期（距上次滚动 >500ms）时刷新。
    const now = performance.now()
    const IDLE_THRESHOLD_MS = 500
    if (
      this.cachedPreviewMaxScroll === null ||
      now - this.lastScrollTime > IDLE_THRESHOLD_MS
    ) {
      this.cachedPreviewMaxScroll =
        Math.max(1, previewEl.scrollHeight - previewEl.clientHeight)
    }
    const dstMax = this.cachedPreviewMaxScroll

    this.syncedPane = 'preview'
    previewEl.scrollTop = ratio * dstMax
    this.armClear()
  }

  // ════════════════════════════════════════════════════════════════
  // 预览 → 编辑器：块行号映射（保留原 §12.1 设计）
  // ════════════════════════════════════════════════════════════════
  // 取视口顶部块，按块内像素进度插值到源码行，再用 coordsAtPos 定位亚行级像素。
  // 此方向无密度不对称问题（预览像素多→编辑器行少时 coordsAtPos 自然收敛）。
  // ════════════════════════════════════════════════════════════════
  private syncPreviewToEditor(view: EditorView, blocks: Block[]): void {
    const previewEl = this.elements['preview']
    if (!previewEl) return

    // 边界对齐：源侧（预览）到顶/到底时，目标侧（编辑器）直接对齐到顶/底。
    if (previewEl.scrollTop <= 0) {
      this.syncedPane = 'editor'
      view.scrollDOM.scrollTop = 0
      this.armClear()
      return
    }
    if (previewEl.scrollTop + previewEl.clientHeight >= previewEl.scrollHeight - 1) {
      this.syncedPane = 'editor'
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
      this.armClear()
      return
    }

    if (!this.ensureLayout(previewEl, blocks)) return
    const layout = this.previewLayout!

    // 视口顶在预览内容坐标系中的文档位置。
    const containerTopDoc = previewEl.scrollTop
    let target: Block | null = null
    let t = 0
    let h = 1
    for (const b of blocks) {
      const bt = layout.top.get(b.id)
      const bh = layout.height.get(b.id)
      if (bt === undefined || bh === undefined) continue
      if (containerTopDoc >= bt && containerTopDoc < bt + bh) {
        target = b
        t = bt
        h = bh
        break
      }
    }
    if (!target) {
      // 兜底：取第一个底部越过容器顶部的块（视口内最靠上的块）。
      for (const b of blocks) {
        const bt = layout.top.get(b.id)
        const bh = layout.height.get(b.id)
        if (bt === undefined || bh === undefined) continue
        if (bt + bh > containerTopDoc) {
          target = b
          t = bt
          h = bh
          break
        }
      }
    }
    if (!target) return

    // 源侧块内进度（按像素）：容器顶进入该块的深度 / 块高。
    const f = h > 0 ? Math.min(1, Math.max(0, (containerTopDoc - t) / h)) : 0

    // 目标侧：插值到亚行级像素位置，连续滚动编辑器。
    const span = Math.max(1, target.endLine - target.startLine)
    const lineF = target.startLine + f * span
    const lineNo = Math.max(1, Math.min(Math.floor(lineF), view.state.doc.lines))
    const frac = Math.min(1, Math.max(0, lineF - lineNo))

    const scrollerRect = view.scrollDOM.getBoundingClientRect()
    const topCoords = view.coordsAtPos(view.state.doc.line(lineNo).from)
    if (!topCoords) {
      // 兜底：coordsAtPos 暂不可用（极少见），退回行粒度滚动。
      const line = view.state.doc.line(lineNo)
      this.syncedPane = 'editor'
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
      this.armClear()
      return
    }
    // 行在编辑器中的真实文档坐标（含 .cm-content 24px 顶 padding，与 scrollIntoView 口径一致）。
    const lineTopDoc = topCoords.top - scrollerRect.top + view.scrollDOM.scrollTop

    // 行高：相邻行的像素差（末行用上一行差，单行/首行兜底 20px）。
    let lineH = 20
    if (lineNo < view.state.doc.lines) {
      const next = view.coordsAtPos(view.state.doc.line(lineNo + 1).from)
      if (next) lineH = Math.max(1, next.top - topCoords.top)
    } else if (lineNo > 1) {
      const prev = view.coordsAtPos(view.state.doc.line(lineNo - 1).from)
      if (prev) lineH = Math.max(1, topCoords.top - prev.top)
    }

    this.syncedPane = 'editor'
    view.scrollDOM.scrollTop = lineTopDoc + frac * lineH
    this.armClear()
  }

  private armClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer)
    this.clearTimer = setTimeout(() => this.clearLock(), 80)
  }
}

export const scrollSync = new ScrollSyncController()
