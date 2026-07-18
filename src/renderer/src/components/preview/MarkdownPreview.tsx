import React, { useState, useRef, useEffect } from 'react'
import { useUIStore } from '../../store/ui'
import { parseMarkdown } from '../../lib/parseClient'
import type { RenderResult } from '../../lib/markdownPipeline'
import { SafeHtml } from '../SafeHtml'
import { scrollSync } from '../../lib/scrollSync'
import mermaid from 'mermaid'

let mermaidInitialized = false
function ensureMermaid(): void {
  if (!mermaidInitialized) {
    mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false })
    mermaidInitialized = true
  }
}

// 模块级串行队列：mermaid 内部有全局状态（共享 id/临时 DOM），并发 render 会串图/报错，
// 故所有 render 排队执行。
let mermaidChain: Promise<unknown> = Promise.resolve()
function renderMermaidSvg(id: string, code: string): Promise<{ svg: string }> {
  const task = mermaidChain.then(() => mermaid.render(id, code.trim()))
  mermaidChain = task.catch(() => undefined) // 失败也续链，不影响后续
  return task as Promise<{ svg: string }>
}

interface MarkdownPreviewProps {
  content: string
}

export function MarkdownPreview({ content }: MarkdownPreviewProps): React.ReactElement {
  const previewRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderToken = useRef(0)
  const lastDocIdRef = useRef<string | null | undefined>(undefined)
  const [renderedHtml, setRenderedHtml] = useState('')
  const [loading, setLoading] = useState(true)
  // docId 取自全局 store，经 comlink 传入 Worker 用于 appdoc: 图片重写。
  const docId = useUIStore((s) => s.activeDocumentId)

  // 解析：经 comlink 发 Worker，失败自动降级主线程。
  // 首屏 / 切换文档时立即解析（不防抖）；仅同一文档连续输入才防抖 150ms 合并，
  // 避免把防抖延迟加在“打开 / 切换文档”关键路径上（否则预览会先空等才出）。
  useEffect(() => {
    const token = ++renderToken.current
    const isDocSwitch = docId !== lastDocIdRef.current
    lastDocIdRef.current = docId
    const immediate = isDocSwitch || renderedHtml === ''
    let cancelled = false

    // 切换文档：立即清空旧内容并显示 Loading，避免旧文件内容残留。
    if (isDocSwitch) {
      setRenderedHtml('')
      setLoading(true)
    }

    const run = () => {
      parseMarkdown(content, docId)
        .then(async (res: RenderResult) => {
          if (cancelled || token !== renderToken.current) return
          // 注入前烘焙 mermaid：把占位 <div data-mermaid-slot="{i}"> 替换为原始 SVG，
          // 得到含 mermaid SVG 的完整 HTML 串；净化由后续 SafeHtml 单次完成。
          let html = res.html
          if (res.mermaid.length > 0) {
            ensureMermaid()
            const svgs: string[] = []
            for (const m of res.mermaid) {
              const id = `mermaid-${m.hash}-${Math.random().toString(36).slice(2)}`
              try {
                const out = await renderMermaidSvg(id, m.code)
                svgs[m.slot] = out.svg
              } catch {
                svgs[m.slot] = '<div class="mermaid-skeleton">⚠ Mermaid 渲染失败</div>'
              }
            }
            html = html.replace(
              /<div data-mermaid-slot="(\d+)"><\/div>/g,
              (_m, i) => svgs[Number(i)] ?? ''
            )
          }
          if (cancelled || token !== renderToken.current) return
          setRenderedHtml(html)
          setLoading(false)
        })
        .catch((err) => {
          if (cancelled || token !== renderToken.current) return
          console.error('[MarkFlow] Parse failed:', err)
          setLoading(false)
        })
    }

    // 切换文档用 setTimeout(0)：合并“docId 先变、content 经 useLocalDocument 的
    // effect 后变”的瞬时双渲染，仅向 Worker 发送最终 (docId, content) 一次。
    // 同文档连续输入：150ms 防抖合并击键。
    const t = setTimeout(run, immediate ? 0 : 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [content, docId])

  // 容器级 error 委托：图片加载失败时降级为占位符（覆盖注入 HTML 内的所有 <img>）。
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
  }, [renderedHtml])

  // 注册到同步滚动控制器（preview 侧）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    scrollSync.register('preview', el)
    return () => scrollSync.unregister('preview')
  }, [])

  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-auto w-full"
      style={{ background: 'var(--color-surface)' }}
    >
      <article
        ref={previewRef}
        className="markdown-preview prose dark:prose-invert max-w-none px-6 py-6 w-full"
      >
        {loading && renderedHtml === '' ? (
          <div className="text-[var(--color-text-tertiary)] text-sm">Loading preview…</div>
        ) : (
          <SafeHtml html={renderedHtml} />
        )}
      </article>
    </div>
  )
}
