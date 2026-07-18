// Markdown 解析管线（markdown-render-v2-simple 设计）。
// 在 Worker 内运行：把 Markdown 源解析为单段 HTML 字符串 + mermaid 占位数组。
// 净化与 mermaid 烘焙在渲染进程完成（见 sanitize.ts / MarkdownPreview.tsx），
// 本文件只负责「解析」，不碰 DOM（Worker 友好）。
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import frontMatter from 'markdown-it-front-matter'
import container from 'markdown-it-container'
import githubAlerts from 'markdown-it-github-alerts'
import taskLists from 'markdown-it-task-lists'
import hljs from 'highlight.js'
import katex from 'katex'

export interface MermaidSlot {
  slot: number
  code: string
  hash: string
}

export interface RenderResult {
  html: string
  mermaid: MermaidSlot[]
}

// 稳定字符串哈希（djb2），用于 mermaid 缓存键与占位标识。
export function hashCode(s: string): string {
  let h = 0
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `<span class="katex-error" title="${escapeHtml(msg)}">${escapeHtml(tex)}</span>`
  }
}

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        )
      } catch {
        /* 落到自动识别 */
      }
    }
    try {
      return (
        '<pre class="hljs"><code>' + hljs.highlightAuto(str).value + '</code></pre>'
      )
    } catch {
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>'
    }
  },
})

// 标题锚点 id（供目录/定位；不生成可点击 permalink）。
md.use(anchor, { permalink: false })

// Frontmatter 剥离（丢弃，不渲染进预览）。
md.use(frontMatter, () => {})

// GitHub Alerts：> [!NOTE] 等 → <div class="markdown-alert markdown-alert-note">。
md.use(githubAlerts)

// GFM 任务列表：- [ ] / - [x] → <li><input type="checkbox" disabled>。
md.use(taskLists as any, { enabled: true, label: true })

// 自定义容器：:::warning / :::note / :::tip / :::caution / :::important / :::info
// → <div class="warning"> 等。@types/markdown-it-container 的声明与默认导入存在
// 互通摩擦，故用 md.use 并以 any 桥接（运行时即 container(md, name)）。
for (const name of ['warning', 'note', 'tip', 'caution', 'important', 'info']) {
  md.use(container as any, name)
}

// ─── 数学公式（自写 fence/inline 规则调 katex.renderToString，避免第三方插件兼容性风险） ───
// 行内 $...$（含货币空格守卫：首尾空格视为普通文本，如 $5 and $10）。
md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false
  if (src.charCodeAt(pos + 1) === 0x24) return false // $$ 交给块级规则
  const end = src.indexOf('$', pos + 1)
  if (end === -1) return false
  const content = src.slice(pos + 1, end)
  if (!content.trim()) return false
  if (/^\s|\s$/.test(content)) return false // 货币写法守卫
  if (silent) {
    state.pos = end + 1
    return true
  }
  const token = state.push('math_inline', 'math', 0)
  token.content = content
  token.markup = '$'
  state.pos = end + 1
  return true
})
md.renderer.rules.math_inline = (tokens, idx) => renderKatex(tokens[idx].content, false)

// 块级 $$...$$（支持跨多行，至首个以 $$ 结尾的行结束）。
md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const startPos = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (state.src.slice(startPos, startPos + 2) !== '$$') return false
  if (silent) return false

  let content = ''
  let found = false
  let lastLine = startLine
  const firstLine = state.src.slice(startPos + 2, max)
  if (firstLine.trim().endsWith('$$')) {
    content = firstLine.trim().slice(0, -2)
    found = true
  } else {
    content = firstLine
    for (let line = startLine + 1; line <= endLine; line++) {
      const lp = state.bMarks[line] + state.tShift[line]
      const lm = state.eMarks[line]
      const text = state.src.slice(lp, lm)
      lastLine = line
      if (text.trim().endsWith('$$')) {
        content += '\n' + text.trim().slice(0, -2)
        found = true
        break
      }
      content += '\n' + text
    }
  }
  if (!found) return false
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = content.trim()
  token.markup = '$$'
  state.line = lastLine + 1
  return true
})
md.renderer.rules.math_block = (tokens, idx) => renderKatex(tokens[idx].content, true) + '\n'

// ─── Mermaid 抽离：把 ```mermaid 围栏替换为占位 <div data-mermaid-slot="{i}">，
// 并把源码收集进 env.mermaid（纯字符串，无需 DOM）。渲染进程在注入前烘焙 SVG。 ───
const defaultFence =
  md.renderer.rules.fence ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim().split(/\s+/)[0] : ''
  if (info === 'mermaid') {
    const code = token.content
    const slots = (env as { mermaid: MermaidSlot[] }).mermaid
    const slot = slots.length
    slots.push({ slot, code, hash: hashCode(code) })
    return `<div data-mermaid-slot="${slot}"></div>\n`
  }
  return defaultFence(tokens, idx, options, env, self)
}

// ─── 相对图片改写为 appdoc://<docId>/<相对路径>（外链/数据/已 appdoc: 不动） ───
const defaultImage =
  md.renderer.rules.image ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src') || ''
  const docId = (env as { docId?: string | null }).docId
  if (src && !/^(https?:|data:|appdoc:)/i.test(src)) {
    const rel = src.replace(/^\.\//, '')
    if (docId) token.attrSet('src', `appdoc://${docId}/${rel}`)
  }
  return defaultImage(tokens, idx, options, env, self)
}

// 解析入口：返回整篇 HTML（含 mermaid 占位）+ mermaid 源码数组。
export function render(content: string, docId: string | null): RenderResult {
  const env = { docId, mermaid: [] as MermaidSlot[] }
  const html = md.render(content, env)
  return { html, mermaid: env.mermaid }
}
