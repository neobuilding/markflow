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

export function MermaidBlock({ code }: { code: string }): React.ReactElement {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const renderToken = useRef(0)

  useEffect(() => {
    const token = ++renderToken.current
    setError(null)
    setSvg(null)
    const key = mermaidKey(code)
    const cached = mermaidCache.get(key)
    if (cached) {
      setSvg(cached)
      return
    }
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
