// Mermaid 专用渲染块（吸收 PLAN §4.3 竞态防护，设计 §8.6）。
// 仅 Mermaid 这类需 DOM 渲染者走此组件；消费 block.raw 懒渲染。
// securityLevel:'strict' + DOMPurify SVG 净化（纵深，设计 C3）。
import React, { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import DOMPurify from 'dompurify'
import { hashCode } from '../../lib/markdownEngine'

let mermaidInitialized = false
function ensureMermaid(): void {
  if (!mermaidInitialized) {
    mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false })
    mermaidInitialized = true
  }
}

// 模块级串行队列：mermaid 内部有全局状态（共享 id/临时 DOM），多 MermaidBlock
// 并发 render 会串图/报错 → 所有 render 排队执行。
let renderChain: Promise<unknown> = Promise.resolve()
function enqueueMermaid(id: string, code: string): Promise<{ svg: string }> {
  const task = renderChain.then(() => mermaid.render(id, code.trim()))
  renderChain = task.catch(() => undefined) // 失败也续链，不影响后续
  return task
}

// 模块级缓存：按 code 哈希缓存 SVG，跨重挂载/重渲染不重画（mermaid 渲染最贵）。
const mermaidCache = new Map<string, string>()
const mermaidKey = (code: string) => `m-${hashCode(code)}`

// 提前渲染：解析完成后立即对所有 mermaid 块排队渲染，使 SVG 在用户滚动到之前通常已
// 就绪（滚动同步读到的块高即真实高度，避免骨架期高度跳变 / 闪烁，问题#2）。
// 渲染经同一串行队列与缓存，重复 code 不会重画；失败静默忽略（运行时由组件兜底骨架）。
// 返回 Promise：全部排队渲染完成后 resolve —— 调用方据此「等 SVG 真正进入 DOM 后再
// 重建偏移缓存」，否则缓存会量到骨架高度（≈40px），导致后续块 top 偏移、预览提前跳到 mermaid。
export function warmMermaidCache(codes: string[]): Promise<void> {
  const tasks: Promise<unknown>[] = []
  for (const code of codes) {
    if (!code) continue
    const key = mermaidKey(code)
    if (mermaidCache.has(key)) continue
    const id = `mermaid-${key}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    ensureMermaid()
    tasks.push(enqueueMermaid(id, code).catch(() => undefined))
  }
  return Promise.all(tasks).then(() => undefined)
}

export function MermaidBlock({ code }: { code: string }): React.ReactElement {
  // 首帧即从模块级缓存取 SVG：warmMermaidCache 已在解析后提前渲染，多数情况下首帧即出图，
  // 避免「骨架→SVG」这一帧的高度跳变 / 闪烁（问题#2）。取不到再走 effect 兜底渲染。
  const [svg, setSvg] = useState<string | null>(() => mermaidCache.get(mermaidKey(code)) ?? null)
  const [error, setError] = useState<string | null>(null)
  const renderToken = useRef(0)

  useEffect(() => {
    const token = ++renderToken.current
    setError(null)
    const key = mermaidKey(code)
    const cached = mermaidCache.get(key)
    if (cached) {
      setSvg(cached)
      return
    }
    // 仅当无缓存时才回退骨架，避免已命中缓存时闪一下空骨架（问题#2）。
    setSvg(null)
    const id = `mermaid-${key}-${Date.now()}`
    ensureMermaid()
    enqueueMermaid(id, code)
      .then(({ svg: raw }) => {
        if (token !== renderToken.current) return // 竞态：旧结果丢弃
        const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true } }) // 纵深净化
        mermaidCache.set(key, clean)
        setSvg(clean)
      })
      .catch((err) => {
        if (token === renderToken.current) setError(err?.message ?? String(err))
      })
  }, [code])

  if (error) return <div className="mermaid-error">⚠ Mermaid 渲染失败：{error}</div>
  if (!svg) return <div className="mermaid-skeleton" />
  return (
    <div
      className="mermaid-container flex justify-center my-4 overflow-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
