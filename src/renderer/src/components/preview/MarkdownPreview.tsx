import React, { useState, useRef, useEffect } from 'react'
import { marked, type TokenizerAndRendererExtension } from 'marked'
import { markedHighlight } from 'marked-highlight'
import katex from 'katex'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import { scrollSync } from '../../lib/scrollSync'

// Escape a raw string for safe interpolation into HTML we inject via
// dangerouslySetInnerHTML. Used only for the KaTeX error fallback, since
// KaTeX's own output is already sanitized.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// marked is configured exactly once in configureMarkedOnce() (defined below).
// See that function for why a global guard is required.


// ─── Math Rendering (KaTeX) via marked extensions ───────────────────
//
// We register marked tokenizer extensions for `$...$` (inline) and `$$...$$`
// (display). Because marked itself parses the document, math is extracted ONLY
// from real text — never from code spans, fenced/indented code blocks, link
// URLs, autolinks, or raw HTML tags. This removes the entire class of
// "regex pulled `$` out of the wrong place" bugs (the ones we kept patching by
// hand: code blocks, blockquotes, currency symbols, URLs, raw HTML).
//
// Spacing guards on inline `$...$` keep currency like "$5 and $10" as literal
// text: the opening `$` must not be followed by whitespace/`$`, and the closing
// `$` must not be preceded by whitespace or followed by `$`.

// Block-level display math: $$...$$ (may span multiple lines).
const mathBlockExtension: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src: string) {
    // Scan for the first `$$` that sits at the start of the source or a line.
    // We must skip mid-paragraph `$$` (which should stay literal) rather than
    // just returning the first `$$` overall: if the first `$$` is mid-paragraph
    // and we returned `undefined`, marked would treat the WHOLE paragraph as
    // plain text and swallow any *later* valid block `$$` into it. Returning the
    // index of the first line-start `$$` lets marked jump there and render it.
    let i = src.indexOf('$$')
    while (i >= 0) {
      if (i === 0 || src.slice(0, i).endsWith('\n')) return i
      i = src.indexOf('$$', i + 2)
    }
    return undefined
  },
  tokenizer(src: string) {
    const m = /^\$\$([\s\S]+?)\$\$/.exec(src)
    if (m) {
      return { type: 'mathBlock', raw: m[0], text: m[1].trim() }
    }
    return undefined
  },
  renderer(token) {
    try {
      return katex.renderToString(token.text, { displayMode: true, throwOnError: false })
    } catch {
      return `<div class="katex-error"><pre>${escapeHtml(token.text)}</pre></div>`
    }
  },
}

// Inline math: $...$ only. Display math `$$...$$` is handled by the block
// extension above (it must sit on its own line / span lines). We deliberately
// do NOT match `$$...$$` inline here: doing so makes marked's link tokenizer
// choke on `$$` inside a link URL (e.g. `[x](https://a.com/$$b$$)`), breaking
// the link. The single-`$` regex below can never match `$$` (the `(?!\$)`
// guard), so `$...$` is safe inside URLs.
const mathInlineExtension: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src: string) {
    const i = src.indexOf('$')
    return i < 0 ? undefined : i
  },
  tokenizer(src: string) {
    // Inline math $...$ with spacing guards so currency like "$5 and $10"
    // is left as literal text: the opening `$` must not be followed by
    // whitespace/`$`, and the closing `$` must not be preceded by whitespace
    // or followed by `$`.
    const inline = /^\$(?!\s)(?!\$)([^\$\n]+?)(?<!\s)\$/.exec(src)
    if (inline) {
      return { type: 'mathInline', raw: inline[0], text: inline[1].trim() }
    }
    return undefined
  },
  renderer(token) {
    try {
      return katex.renderToString(token.text, { displayMode: false, throwOnError: false })
    } catch {
      return `<span class="katex-error">${escapeHtml(token.text)}</span>`
    }
  },
}

// ─── Configure marked (exactly once) ──────────────────────────────
// marked-highlight registers a `walkTokens` hook, and marked ACCUMULATES
// walkTokens on every marked.use() call. Under Vite HMR this module is
// re-executed on each edit, so re-calling marked.use() would stack the
// highlighter and double-escape fenced code — which corrupts Mermaid blocks
// (their `language-mermaid` source becomes invalid) and breaks syntax
// highlighting. Guard with a globalThis flag so configuration runs once per
// page load. (Editing this file still needs a full page reload to take effect.)
const MARKED_CONFIGURED_FLAG = '__markflowMarkedConfigured'
function configureMarkedOnce(): void {
  const g = globalThis as unknown as Record<string, boolean | undefined>
  if (g[MARKED_CONFIGURED_FLAG]) return
  g[MARKED_CONFIGURED_FLAG] = true

  marked.setOptions({ gfm: true, breaks: false })

  marked.use(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        const language = lang && hljs.getLanguage(lang) ? lang : null
        try {
          if (language) {
            return hljs.highlight(code, { language, ignoreIllegals: true }).value
          }
          return hljs.highlightAuto(code).value
        } catch {
          return code
        }
      },
    })
  )

  marked.use({ extensions: [mathBlockExtension, mathInlineExtension] })
}

configureMarkedOnce()

// ─── Markdown + Mermaid rendering ─────────────────────────────────
//
// We render the markdown to an HTML string, then render each Mermaid
// diagram and splice the resulting <svg> directly into that string. The
// finished HTML (including the Mermaid SVGs) is stored in React state and
// injected via dangerouslySetInnerHTML.
//
// This is deliberate: the previous approach mutated the DOM AFTER React
// injected the HTML (querying `pre > code.language-mermaid` and calling
// `pre.replaceWith(wrapper)` in a useEffect). That mutation was lost
// whenever React re-injected the HTML on a re-render — which happens
// whenever `content` (or a parent) re-renders with a new `html` string.
// Because `mermaid.render` is async, the re-injection could detach the
// very `<pre>` nodes we were about to replace, so the diagrams silently
// vanished. By baking the SVGs into the `html` string itself, a re-render
// just re-injects the *same* HTML that already contains the diagrams, so
// they are never wiped.

let mermaidInitialized = false

async function renderMarkdownWithMermaid(content: string): Promise<string> {
  let html: string
  try {
    // marked parses markdown and our KaTeX extensions render math inline
    // during parsing — no pre/post placeholder juggling needed.
    html = marked.parse(content) as string
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[MarkFlow] Markdown render error:', err)
    return `<div class="px-6 py-6"><p class="text-[var(--color-danger)]">Error rendering preview</p><pre class="text-xs text-[var(--color-text-tertiary)] mt-2 overflow-auto bg-[var(--color-surface-overlay)] p-3 rounded">${escapeHtml(msg)}</pre></div>`
  }

  const container = document.createElement('div')
  container.innerHTML = html

  const codeBlocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid')
  if (codeBlocks.length > 0) {
    const mermaid = await import('mermaid')
    if (!mermaidInitialized) {
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        // 用原生 SVG <text> 渲染标签，而非 <foreignObject> 里的 HTML。
        // 否则 DOMPurify 的 SVG 净化会把 foreignObject 内的 HTML 标签连同
        // 文字一起剥离（已在本地用 jsdom 实测验证）。
        htmlLabels: false,
        fontFamily: 'var(--font-sans)',
      })
      mermaidInitialized = true
    }

    for (const i of Array.from(codeBlocks.keys())) {
      const code = codeBlocks[i]
      const pre = code.parentElement!
      const source = code.textContent || ''
      const id = `mermaid-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

      try {
        const { svg } = await mermaid.default.render(id, source.trim())
        const wrapper = document.createElement('div')
        wrapper.className = 'mermaid-container flex justify-center my-4 overflow-auto'
        // DOMPurify 净化 SVG 输出，避免 CodeQL 的 js/xss-through-dom 告警。
        // mermaid 已配置 htmlLabels:false，输出为纯 SVG（含原生 <text>），
        // 因此 svg profile 即可完整保留图形与文字。
        wrapper.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } })
        pre.replaceWith(wrapper)
      } catch (err) {
        console.warn('[MarkFlow] Mermaid render error:', err)
        const msg = err instanceof Error ? err.message : String(err)
        // Surface the failure in the preview instead of silently leaving the
        // raw source block — otherwise the user only sees code with no clue why.
        const errBox = document.createElement('div')
        errBox.className =
          'mermaid-error rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/5 ' +
          'p-3 my-4 text-sm text-[var(--color-danger)]'
        errBox.textContent = '⚠ Mermaid 渲染失败：' + msg
        pre.replaceWith(errBox)
      }
    }
  }

  return container.innerHTML
}

// ─── Image Error Handling ──────────────────────────────────────────
//
// Markdown 里引用的外部图片（https://…）可能因离线/证书/网络问题加载失败。
// 这类失败是浏览器网络层行为，我们无法用 try/catch 拦截、也无法阻止浏览器
// 输出 "Failed to load resource" 这条原生日志。但我们可以在渲染后给 <img>
// 绑定 error 处理，把破图优雅降级为占位符，避免 UI 破损、避免异常向外抛。
// （best-effort：每次渲染后重新绑定；图片若已成功加载则无需处理。）
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const [renderedHtml, setRenderedHtml] = useState('')
  // Monotonic token so only the latest render result is applied (avoids
  // races when `content` changes rapidly).
  const renderToken = useRef(0)

  // Render markdown + Mermaid to an HTML string, then store it in state.
  // Because the Mermaid SVGs live inside `renderedHtml`, re-renders never
  // wipe them — React just re-injects the same HTML.
  useEffect(() => {
    const token = ++renderToken.current
    let cancelled = false
    renderMarkdownWithMermaid(content)
      .then((html) => {
        if (!cancelled && token === renderToken.current) setRenderedHtml(html)
      })
      .catch((err) => {
        console.error('[MarkFlow] Render pipeline failed:', err)
        if (!cancelled && token === renderToken.current) {
          const msg = err instanceof Error ? err.message : String(err)
          setRenderedHtml(
            `<div class="px-6 py-6"><p class="text-[var(--color-danger)]">Error rendering preview</p><pre class="text-xs text-[var(--color-text-tertiary)] mt-2 overflow-auto bg-[var(--color-surface-overlay)] p-3 rounded">${escapeHtml(msg)}</pre></div>`
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [content])

  // Best-effort image error fallback: re-attach after each rendered HTML.
  useEffect(() => {
    const container = previewRef.current
    if (container) enhanceImages(container)
  }, [renderedHtml])

  // 注册到同步滚动控制器：预览窗格作为 "preview" 一侧
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    scrollSync.register('preview', el)
    return () => scrollSync.unregister('preview')
  }, [])

  return (
    <div ref={scrollRef} className="h-full overflow-auto w-full" style={{ background: 'var(--color-surface)' }}>
      <div
        ref={previewRef}
        className="markdown-preview px-6 py-6 w-full"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    </div>
  )
}
