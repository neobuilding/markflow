import React, { useState, useRef, useEffect, Component, type ReactNode } from 'react'
import { useUIStore } from '../../store/ui'
import { parseMarkdown } from '../../lib/parseClient'
import type { Block } from '../../lib/markdownEngine'
import { Block as PreviewBlock } from './Block'
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
  const [blocks, setBlocks] = useState<Block[]>([])
  // docId 取自全局 store（§4.3），经 comlink 传入 Worker 用于 appdoc: 图片重写。
  const docId = useUIStore((s) => s.activeDocumentId)

  // 解析（防抖 200ms，经 comlink 发 Worker；失败自动降级主线程，§4.8）
  useEffect(() => {
    const token = ++renderToken.current
    const t = setTimeout(() => {
      parseMarkdown(content, docId)
        .then((bs) => {
          if (token !== renderToken.current) return
          blocksRef.current = bs
          setBlocks(bs)
        })
        .catch((err) => {
          if (token !== renderToken.current) return
          console.error('[MarkFlow] Parse failed:', err)
        })
    }, 200)
    return () => clearTimeout(t)
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
      style={{ background: 'var(--color-surface)' }}
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
