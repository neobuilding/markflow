// Markdown parsing pipeline (markdown-render-v2-simple design).
// Runs inside a Worker: parse Markdown source into a single HTML string + a mermaid slot array.
// Sanitization and mermaid baking happen in the renderer (see sanitize.ts / MarkdownPreview.tsx);
// this file only handles "parsing" and never touches the DOM (Worker-friendly).
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import frontMatter from 'markdown-it-front-matter'
import container from 'markdown-it-container'
import githubAlerts from 'markdown-it-github-alerts'
import taskLists from 'markdown-it-task-lists'
import hljs from 'highlight.js'
import katex from 'katex'
import texmath from 'markdown-it-texmath'

export interface MermaidSlot {
  slot: number
  code: string
  hash: string
}

export interface RenderResult {
  html: string
  mermaid: MermaidSlot[]
}

// Stable string hash (djb2), used for mermaid cache keys and placeholder ids.
export function hashCode(s: string): string {
  let h = 0
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
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
        /* fall through to auto-detect */
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

// Heading anchor ids (for TOC / navigation; does not generate clickable permalinks).
md.use(anchor, { permalink: false })

// Frontmatter stripping (discarded, not rendered into preview).
md.use(frontMatter, () => {})

// GitHub Alerts: > [!NOTE] etc. -> <div class="markdown-alert markdown-alert-note">.
md.use(githubAlerts)

// GFM task lists: - [ ] / - [x] -> <li><input type="checkbox" disabled>.
md.use(taskLists as any, { enabled: true, label: true })

// Custom containers: :::warning / :::note / :::tip / :::caution / :::important / :::info
// -> <div class="warning"> etc. The @types/markdown-it-container declaration and default import have
// interop friction, so we use md.use with an any bridge (runs as container(md, name) at runtime).
for (const name of ['warning', 'note', 'tip', 'caution', 'important', 'info']) {
  md.use(container as any, name)
}

// ─── Math formulas (markdown-it-texmath handles $…$ / $$…$$ delimiter recognition, KaTeX does the rendering) ───
// Only enable the dollars delimiter style (not the brackets \(…\) / \[…\] style).
// [Pure dependency, zero patching] We do not modify texmath internals: keep texmath's default <eq>/<eqn>/<section>
// wrappers, which are non-standard tags dropped by DOMPurify during sanitization while the inner KaTeX is kept;
// <section> is a standard HTML tag and is kept, serving only as a harmless block-level semantic wrapper (see Plan §7 risk 4).
// Formula boundary detection (delimiter recognition, inline/block split, currency $ guard via $_pre/$_post) is 100%
// from the regex rules injected by texmath; this project writes no $ / $$ boundary-detection code of its own.
md.use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: { throwOnError: false, output: 'htmlAndMathml' },
})

// ─── Mermaid extraction: replace ```mermaid fences with placeholder <div data-mermaid-slot="{i}">,
//   and collect the source into env.mermaid (plain string, no DOM needed). The renderer bakes SVG before injection. ───
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

// ─── Rewrite relative images to appdoc://<docId>/<relativePath> (leave external/data/already-appdoc: alone) ───
const defaultImage =
  md.renderer.rules.image ||
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src') || ''
  if (/^https?:/i.test(src)) {
    // Remote image: tighten the source site (hide Referer) to avoid leaking the local file path.
    token.attrSet('referrerpolicy', 'no-referrer')
  } else if (!/^(https?:|data:|appdoc:)/i.test(src)) {
    const docId = (env as { docId?: string | null }).docId
    const rel = src.replace(/^\.\//, '')
    if (docId) token.attrSet('src', `appdoc://${docId}/${rel}`)
  }
  return defaultImage(tokens, idx, options, env, self)
}

// Parse entry: return the whole HTML (with mermaid placeholders) + the mermaid source array.
export function render(content: string, docId: string | null): RenderResult {
  const env = { docId, mermaid: [] as MermaidSlot[] }
  const html = md.render(content, env)
  return { html, mermaid: env.mermaid }
}
