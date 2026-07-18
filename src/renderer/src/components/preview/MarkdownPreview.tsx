import React, { useState, useRef, useEffect, Component, type ReactNode } from 'react'
import { useUIStore } from '../../store/ui'
import { parseMarkdown } from '../../lib/parseClient'
import type { Block } from '../../lib/markdownEngine'
import { Block as PreviewBlock } from './Block'
import { warmMermaidCache } from './MermaidBlock'
import { scrollSync } from '../../lib/scrollSync'
import 'katex/dist/katex.min.css'

// 渲染错误边界：某块渲染异常时仅显示错误提示，不白屏（§4.8）。
class PreviewErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('[MarkFlow] Preview render error:', error)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="px-6 py-6 text-[var(--color-danger)]">
          预览渲染出错：{this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

interface MarkdownPreviewProps {
  content: string
}

export function MarkdownPreview({ content }: MarkdownPreviewProps): React.ReactElement {
  const previewRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const blocksRef = useRef<Block[]>([])
  const renderToken = useRef(0)
  const lastDocIdRef = useRef<string | null | undefined>(undefined)
  const [blocks, setBlocks] = useState<Block[]>([])
  // docId 取自全局 store（§4.3），经 comlink 传入 Worker 用于 appdoc: 图片重写。
  const docId = useUIStore((s) => s.activeDocumentId)

  // 解析：经 comlink 发 Worker，失败自动降级主线程（§4.8）。
  // 首屏 / 切换文档时立即解析（不防抖）；仅同一文档的连续输入才防抖 200ms 合并，
  // 避免把防抖延迟加在“打开 / 切换文档”这一关键路径上（否则预览会先空等 200ms 才出）。
  useEffect(() => {
    const token = ++renderToken.current
    const isDocSwitch = docId !== lastDocIdRef.current
    lastDocIdRef.current = docId
    const immediate = isDocSwitch || blocksRef.current.length === 0
    let cancelled = false

    // 切换文档：立即清空旧内容并展示 Loading preview…，避免旧文件内容残留；
    // 新内容解析完成前一直显示占位（仅切换文档触发，同文档连续输入不触发以免输入抖动）。
    if (isDocSwitch) {
      blocksRef.current = []
      setBlocks([])
    }

    const run = () => {
      parseMarkdown(content, docId)
        .then((bs) => {
          if (cancelled || token !== renderToken.current) return
          blocksRef.current = bs
          setBlocks(bs)
          // 解析完成即提前渲染所有 mermaid（见 MermaidBlock.warmMermaidCache），
          // 使 SVG 在滚动到之前就绪，消除骨架期高度跳变 / 闪烁。
          const mermaidCodes = bs
            .filter((b) => b.type === 'mermaid')
            .map((b) => b.raw ?? '')
            .filter(Boolean)
          // 刷新偏移缓存供「预览→编辑器」方向使用（不再需要等 SVG 就绪，
          // 比例映射已消除编辑器→预览方向的失步根因）。
          scrollSync.refreshLayout()
          warmMermaidCache(mermaidCodes)

          // 预热非 mermaid 块的 contain-intrinsic-size：强制 visible 一帧让浏览器
          // 计算并记住真实尺寸，随后**恢复原值**（mermaid 为 visible、其余为 auto）。
          // 否则首次滚过时，屏外块才首次渲染 → 布局回流 + scrollHeight 跳变 →
          // 比例映射分母跳变（配合 scrollSync 的 dstMax 冻结）→ 预览「颤抖」。
          // 注意：必须恢复原始 content-visibility，绝不能清成 '' —— 非 mermaid 块的
          // content-visibility:auto 仅由 Block.tsx 内联设置（CSS 无兜底），清成 ''
          // 会使其永久变 visible，废掉性能优化与尺寸记忆机制。mermaid 块本就常驻
          // visible（Block.tsx），其 SVG 就绪前的骨架高度由 .mermaid-skeleton 提供稳定
          // 最小高度，故无需在此预热。
          requestAnimationFrame(() => {
            const container = scrollRef.current
            if (!container) return
            const els = container.querySelectorAll<HTMLElement>('[data-block-id]')
            if (els.length === 0) return
            const originals = new Map<HTMLElement, string>()
            els.forEach((el) => {
              originals.set(el, el.style.contentVisibility)
              el.style.contentVisibility = 'visible'
            })
            // 次帧恢复：首帧完成布局并记录 intrinsic size，渲染管线 flush 后切回原值。
            requestAnimationFrame(() => {
              els.forEach((el) => {
                el.style.contentVisibility = originals.get(el) ?? 'auto'
              })
            })
          })
        })
        .catch((err) => {
          if (cancelled || token !== renderToken.current) return
          console.error('[MarkFlow] Parse failed:', err)
        })
    }

    // 切换文档用 setTimeout(0)（而非同步 run）：合并“docId 先变、content 经
    // useLocalDocument 的 effect 后变”的瞬时双渲染（见 useLocalDocument.ts:26）。
    // 两次渲染共用一个可取消定时器，仅向 Worker 发送最终 (docId, content) 一次，
    // 避免对上一文档内容做一次多余（可能很大）的解析、拖慢新文档预览出现
    // （若同步 run，旧内容会被先发进 Worker；token 取消的只是 setState，Worker 仍会算）。
    // 同文档连续输入：200ms 防抖合并击键，且不闪 Loading。
    const t = setTimeout(run, immediate ? 0 : 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [content, docId])

  // 容器级 error 委托：图片加载失败时降级为占位符（§4.5，覆盖所有注入块内的 <img>）
  useEffect(() => {
    const container = previewRef.current
    if (!container) return
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target || target.tagName !== 'IMG') return
      const img = target as HTMLImageElement
      if (img.dataset.fallbackApplied) return
      img.dataset.fallbackApplied = '1'
      const placeholder = document.createElement('span')
      placeholder.className = 'img-error-placeholder'
      const alt = img.getAttribute('alt') ?? ''
      placeholder.textContent = alt ? `⚠ 图片加载失败：${alt}` : '⚠ 图片加载失败'
      placeholder.style.cssText =
        'display:inline-block;padding:4px 8px;margin:4px 0;border:1px dashed var(--color-border);' +
        'border-radius:6px;color:var(--color-text-tertiary);font-size:12px;background:var(--color-surface-overlay);'
      img.replaceWith(placeholder)
    }
    container.addEventListener('error', handler, true)
    return () => container.removeEventListener('error', handler, true)
  }, [blocks])

  // 注册到同步滚动控制器（preview 侧，提供 getBlocks 供行号映射，§4.7）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    scrollSync.register('preview', el, { getBlocks: () => blocksRef.current })
    return () => scrollSync.unregister('preview')
  }, [])

  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-auto w-full"
      // overflow-anchor:none：关闭浏览器滚动锚定。编辑器驱动预览时，syncEditorToPreview
      // 每帧以绝对 scrollTop 驱动预览；若浏览器因「视口上方块尺寸变化（如 mermaid/图片渲染）」
      // 自动调整 scrollTop 做锚定，会与我们的绝对写入互相打架 → 预览快速闪烁（问题#2）。
      // 预览位置本就由 scrollSync 的块偏移缓存 + ResizeObserver 自行管理，无需浏览器锚定。
      style={{ background: 'var(--color-surface)', overflowAnchor: 'none' }}
    >
      <article className="markdown-preview prose dark:prose-invert max-w-none px-6 py-6 w-full">
        <PreviewErrorBoundary>
          {blocks.length === 0 ? (
            <div className="text-[var(--color-text-tertiary)] text-sm">Loading preview…</div>
          ) : (
            blocks.map((b) => <PreviewBlock key={b.id} block={b} />)
          )}
        </PreviewErrorBoundary>
      </article>
    </div>
  )
}
