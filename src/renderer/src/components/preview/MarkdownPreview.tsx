import React, { useMemo, useRef, useEffect } from 'react'
import { marked } from 'marked'
import katex from 'katex'
import 'katex/dist/katex.min.css'

// Configure marked
marked.setOptions({
  gfm: true,
  breaks: false,
})

// ─── Math Rendering Strategy ────────────────────────────────────────
//
// TOKENIZE-BEFORE-PARSE:
//
// 1. GLOBAL PASS: Extract $$...$$ (block math, may span multiple lines)
//    → replace with %%KATEX_BLOCK_N%% placeholders.
// 2. LINE-BY-LINE PASS: Extract $...$ (inline math) on each line,
//    BUT skip lines inside fenced code blocks (```...```).
//    → replace with %%KATEX_INLINE_N%% placeholders.
// 3. Pass the fully tokenized content to marked.parse() → clean HTML.
// 4. Replace all placeholders with KaTeX-rendered HTML.
//
// This way LaTeX source is taken directly from raw markdown — it never
// goes through HTML entity encoding/decoding, so no &amp; / &quot; issues.

interface MathBlock {
  type: 'block' | 'inline'
  source: string        // raw LaTeX source
  placeholder: string    // e.g. %%KATEX_BLOCK_0%%
}

/** Tokenize math from raw markdown */
function tokenizeMath(markdown: string): { tokenized: string; blocks: MathBlock[] } {
  const blocks: MathBlock[] = []
  let blockIndex = 0
  let inlineIndex = 0

  // ── Step 1: Global block-math extraction (handles multi-line $$...$$) ───
  // We must do this FIRST, before line-by-line processing,
  // because $$...$$ can span many lines and a per-line regex can't match it.
  let afterBlocks = markdown.replace(
    /\$\$([\s\S]+?)\$\$/g,
    (_match, source) => {
      const ph = `%%KATEX_BLOCK_${blockIndex}%%`
      blocks.push({ type: 'block', source, placeholder: ph })
      blockIndex++
      return ph
    }
  )

  // ── Step 2: Per-line inline-math extraction, skipping fenced code blocks ───
  const lines = afterBlocks.split('\n')
  let inFence = false
  const outLines: string[] = []

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()

    // Track fenced code block boundaries
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      outLines.push(rawLine)
      continue
    }

    // Inside a fence: pass through verbatim, no inline math tokenization
    if (inFence) {
      outLines.push(rawLine)
      continue
    }

    // Outside fences: extract $...$ inline math
    // Match $ that is not adjacent to another $
    const processed = rawLine.replace(
      /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g,
      (_match, source) => {
        const ph = `%%KATEX_INLINE_${inlineIndex}%%`
        blocks.push({ type: 'inline', source, placeholder: ph })
        inlineIndex++
        return ph
      }
    )

    outLines.push(processed)
  }

  return { tokenized: outLines.join('\n'), blocks }
}

/** Render all math blocks via KaTeX → placeholder→HTML map */
function renderMath(blocks: MathBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const b of blocks) {
    try {
      const html = katex.renderToString(b.source.trim(), {
        displayMode: b.type === 'block',
        throwOnError: false,
      })
      map.set(b.placeholder, html)
    } catch {
      const fallback = b.type === 'block'
        ? `<div class="katex-error"><pre>${b.source}</pre></div>`
        : `<span class="katex-error">${b.source}</span>`
      map.set(b.placeholder, fallback)
    }
  }
  return map
}

// ─── Mermaid Rendering ─────────────────────────────────────────────

async function renderMermaidInDOM(container: HTMLElement): Promise<void> {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
  if (codeBlocks.length === 0) return

  const mermaid = await import('mermaid')
  mermaid.default.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'var(--font-sans)',
  })

  for (const i of Array.from(codeBlocks.keys())) {
    const code = codeBlocks[i]
    const pre = code.parentElement!
    const source = code.textContent || ''
    const id = `mermaid-${i}-${Date.now()}`

    try {
      const { svg } = await mermaid.default.render(id, source.trim())
      const wrapper = document.createElement('div')
      wrapper.className = 'mermaid-container flex justify-center my-4 overflow-auto'
      wrapper.innerHTML = svg
      pre.replaceWith(wrapper)
    } catch (err) {
      console.warn('[MarkFlow] Mermaid render error:', err)
      pre.className += ' ring-2 ring-[var(--color-danger)]'
      pre.title = String(err)
    }
  }
}

// ─── Image Error Handling ──────────────────────────────────────────
//
// Markdown 里引用的外部图片（https://…）可能因离线/证书/网络问题加载失败。
// 这类失败是浏览器网络层行为，我们无法用 try/catch 拦截、也无法阻止浏览器
// 输出 "Failed to load resource" 这条原生日志。但我们可以在渲染后给 <img>
// 绑定 error 处理，把破图优雅降级为占位符，避免 UI 破损、避免异常向外抛。
function enhanceImages(container: HTMLElement): void {
  const imgs = container.querySelectorAll('img')
  imgs.forEach((img) => {
    const handleError = () => {
      if (img.parentElement?.contains(img) === false) return // 已替换，避免重复
      const placeholder = document.createElement('span')
      placeholder.className = 'img-error-placeholder'
      placeholder.textContent = img.alt
        ? `⚠ 图片加载失败：${img.alt}`
        : '⚠ 图片加载失败'
      placeholder.style.cssText =
        'display:inline-block;padding:4px 8px;margin:4px 0;border:1px dashed var(--color-border);' +
        'border-radius:6px;color:var(--color-text-tertiary);font-size:12px;background:var(--color-surface-overlay);'
      img.replaceWith(placeholder)
    }
    img.addEventListener('error', handleError, { once: true })
    // 同步场景：图片在监听器绑定前就已失败（如缓存命中失败）
    if (img.complete && img.naturalWidth === 0) handleError()
  })
}

// ─── Component ─────────────────────────────────────────────────────

interface MarkdownPreviewProps {
  content: string
}

export function MarkdownPreview({ content }: MarkdownPreviewProps): React.ReactElement {
  const previewRef = useRef<HTMLDivElement>(null)
  const isRenderingMermaid = useRef(false)

  const html = useMemo(() => {
    try {
      // Step 1: Tokenize math from raw markdown (before HTML conversion!)
      const { tokenized, blocks } = tokenizeMath(content)

      // Step 2: Render all LaTeX via KaTeX
      const mathMap = renderMath(blocks)

      // Step 3: Parse tokenized markdown → HTML (no math left to interfere)
      let result = marked.parse(tokenized) as string

      // Step 4: Replace placeholders with KaTeX output
      for (const [ph, rendered] of mathMap) {
        result = result.split(ph).join(rendered)
      }

      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[MarkFlow] Markdown render error:', err)
      return `<div class="px-6 py-6"><p class="text-[var(--color-danger)]">Error rendering preview</p><pre class="text-xs text-[var(--color-text-tertiary)] mt-2 overflow-auto bg-[var(--color-surface-overlay)] p-3 rounded">${msg.replace(/</g, '&lt;')}</pre></div>`
    }
  }, [content])

  // Mermaid diagrams + image error fallback: post-process in DOM
  useEffect(() => {
    const container = previewRef.current
    if (!container || isRenderingMermaid.current) return
    const timer = setTimeout(async () => {
      isRenderingMermaid.current = true
      try {
        enhanceImages(container)
        await renderMermaidInDOM(container)
      } finally {
        isRenderingMermaid.current = false
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [html])

  return (
    <div className="h-full overflow-auto w-full" style={{ background: 'var(--color-surface)' }}>
      <div
        ref={previewRef}
        className="markdown-preview px-6 py-6 w-full"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
