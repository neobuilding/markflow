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

// `markdown-it` v15 ships its own types and exposes the instance type as a named export
// (`type MarkdownIt`) while the default import is the constructor value only. Import the
// instance type explicitly rather than relying on the default import doubling as a type.
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it'

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

// Render the fence language as a `data-lang` attribute so the preview context menu can
// offer "Copy language" . The value comes from the fence info string
// (user-authored), so it is attribute-escaped before being interpolated into the tag.
// DOMPurify lets it through because `data-*` is allowed by default (ALLOW_DATA_ATTR).
export function codeLangAttr(lang: string): string {
  const escaped = lang
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return ` data-lang="${escaped}"`
}

const md: MarkdownItInstance = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code' +
          codeLangAttr(lang) +
          '>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        )
      } catch {
        /* fall through to auto-detect */
      }
    }
    try {
      return '<pre class="hljs"><code>' + hljs.highlightAuto(str).value + '</code></pre>'
    } catch {
      // highlightAuto can throw on pathological input; degrade gracefully to escaped plain text.
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>'
    }
  },
})

// Heading anchor ids (for TOC / navigation; does not generate clickable permalinks).
// `markdown-it-anchor` v9 types narrow `permalink` to a generator, but omitting the option
// yields the same "no permalink" behavior we want, so we pass no options.
md.use(anchor)

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
// <section> is a standard HTML tag and is kept, serving only as a harmless block-level semantic wrapper (see the Plan doc's sanitization risk discussion).
// Formula boundary detection (delimiter recognition, inline/block split, currency $ guard via $_pre/$_post) is 100%
// from the regex rules injected by texmath; this project writes no $ / $$ boundary-detection code of its own.
md.use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: { throwOnError: false, output: 'htmlAndMathml' },
})

// ─── Mermaid extraction: replace ```mermaid fences with placeholder <div data-mermaid-slot="{i}">,
//   and collect the source into env.mermaid (plain string, no DOM needed). The renderer bakes
//   SVG AFTER injection: lazily in the preview, completely for export / print / copy (ADR 0019). ───
// markdown-it always provides a built-in fence rule, so no fallback is needed.
const defaultFence = md.renderer.rules.fence!

// R6 (D-G, extended): the core `source_line` ruler (below) adds `data-line` via
// `token.attrJoin`, but the fence renderer emits its output as a RAW STRING and the
// `highlight` option short-circuits markdown-it's token-attribute rendering, so that
// ruler never reaches a `<pre>` or a mermaid placeholder. To keep the plan's
// "every top-level block carries data-line" guarantee (§5.1 / Step 1 checklist) we inject
// it here for level-0 code & mermaid blocks. Non-top-level fences (nested inside a
// container / blockquote) are deliberately skipped so the attribute count stays minimal
// and nested structure is never double-tagged.
function fenceDataLineAttr(token: { level: number; map: number[] | null }): string {
  return token.level === 0 && token.map ? ` data-line="${token.map[0]}"` : ''
}

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim().split(/\s+/)[0] : ''
  const lineAttr = fenceDataLineAttr(token)
  if (info === 'mermaid') {
    const code = token.content
    const slots = (env as { mermaid: MermaidSlot[] }).mermaid
    const slot = slots.length
    slots.push({ slot, code, hash: hashCode(code) })
    return `<div data-mermaid-slot="${slot}"${lineAttr}></div>\n`
  }
  const out = defaultFence(tokens, idx, options, env, self)
  // Inject data-line into the opening `<pre>` tag for top-level code blocks. defaultFence
  // returns either the `highlight` string (`<pre class="hljs">…`) or a `<pre><code>` built
  // via renderToken — in both cases the opening `<pre>` is the first (and only) `<pre`.
  return lineAttr ? out.replace(/<pre\b/, `<pre${lineAttr}`) : out
}

// ─── Rewrite relative images to appdoc://<docId>/<relativePath> (leave external/data/already-appdoc: alone) ───
// markdown-it always provides a built-in image rule, so no fallback is needed.
const defaultImage = md.renderer.rules.image!

// Rewrite a (possibly null) image src into its final form:
//  - null/empty: returned unchanged (no point rewriting a non-existent path);
//  - remote (http/https): keep as-is but tighten the referrer policy;
//  - data:/appdoc:/already-absolute: leave untouched;
//  - relative: prefix with appdoc://<docId>/ when a docId is known.
export function rewriteImageSrc(src: string | null | undefined, docId: string | null): string {
  const s = src ?? ''
  if (!s) return s
  if (/^https?:/i.test(s)) return s
  if (/^(https?:|data:|appdoc:)/i.test(s) || !docId) return s
  const rel = s.replace(/^\.\//, '')
  return `appdoc://${docId}/${rel}`
}

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  // markdown-it always sets a src attribute on image tokens (an empty destination such as
  // `![x]()` yields ""), so attrGet never actually returns null here; the `?? ''` only
  // satisfies its nullable type and is therefore not reachable in tests.
  /* v8 ignore next */
  const src = String(token.attrGet('src') ?? '')
  const docId = (env as { docId?: string | null }).docId ?? null
  const finalSrc = rewriteImageSrc(src, docId)
  if (/^https?:/i.test(src)) {
    // Remote image: tighten the source site (hide Referer) to avoid leaking the local file path.
    token.attrSet('referrerpolicy', 'no-referrer')
  } else if (finalSrc !== src) {
    token.attrSet('src', finalSrc)
  }
  return defaultImage(tokens, idx, options, env, self)
}

// ─── Source-line mapping (R6): tag every TOP-LEVEL block with a `data-line` attribute
//   carrying its 0-based source line. This gives scroll-sync / "jump to source" / stage-2
//   rich-text-copy a precise, stable mapping instead of the old ratio heuristics.
//   Only `level === 0` tokens have a `map` (their [startLine, endLine] in the source),
//   and we deliberately skip deeper tokens so the attribute count stays minimal and the
//   nested structure is never double-tagged. The ruler is pushed AFTER all `md.use(...)`
//   plugins, so heading ids (from markdown-it-anchor's own core rule) are already present
//   by the time we add `data-line` — they never collide.
md.core.ruler.push('source_line', (state) => {
  for (const token of state.tokens) {
    // v8 ignore next -- defensive guard: every real top-level block token carries a
    // `map`; no fixture produces a level-0 token without one, so this branch is
    // unreachable in tests but required to avoid a TypeError on malformed input.
    if (token.level !== 0 || !token.map) continue
    token.attrJoin('data-line', String(token.map[0]))
  }
})

// Parse entry: return the whole HTML (with mermaid placeholders) + the mermaid source array.
export function render(content: string, docId: string | null): RenderResult {
  const env = { docId, mermaid: [] as MermaidSlot[] }
  const html = md.render(content, env)
  return { html, mermaid: env.mermaid }
}
