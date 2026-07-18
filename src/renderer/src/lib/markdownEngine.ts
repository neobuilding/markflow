// 共享 Markdown 解析引擎（设计 §8 / O6）。
// 同时被解析 Worker（parse.worker.ts）与主线程降级路径（parseClient.ts）复用，
// 保证两条路径产出同形状的 blocks[]。
//
// 管线分为两段处理器（性能优化，见 §4.2）：
//   mdastProc —— 仅 remark 级变换，整树 run 一次（归一化 mdast）。
//   hastProc —— remarkRehype(mdast→hast) + rehype 变换 + 末位 rehype-sanitize，
//              逐块 run（每块单点净化，C1）。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkDirective from 'remark-directive'
import remarkGithubAlerts from 'remark-github-alerts'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypePrettyCode from 'rehype-pretty-code'
import rehypeSanitize from 'rehype-sanitize'
import rehypeRaw from 'rehype-raw'
import { toHtml } from 'hast-util-to-html'
import { VFile } from 'vfile'
import { sanitizeSchema } from './sanitizeSchema'

export interface Block {
  id: string
  html: string
  type: 'mermaid' | 'directive' | 'normal'
  raw?: string
  startLine: number
  endLine: number
}

// ─── 自定义 remark 步骤：行内 $...$ 空格守卫（复刻旧 mathInlineExtension） ───
// 内容首尾含空白（即 $ 紧邻空格，典型货币写法 $5 and $10）的 inlineMath
// 还原为纯文本，避免被 rehype-katex 误渲染成公式；行内公式 $E = mc^2$ 正常。
const remarkMathSpaceGuard = () => (tree: any) => {
  const visit = (node: any, idx?: number, parent?: any) => {
    if (node.type === 'inlineMath') {
      const value: string = node.value ?? ''
      if (/^\s|\s$/.test(value)) {
        if (parent && typeof idx === 'number') {
          parent.children[idx] = { type: 'text', value: `$${value}$` }
        }
        return
      }
    }
    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) visit(node.children[i], i, node)
    }
  }
  visit(tree)
}

// ─── 自定义 rehype 步骤：把 mermaid 围栏从 shiki 高亮范围剥离 ───
// 把 <code class="language-mermaid"> 重命名为占位 'mermaid'，shiki 不识别 → 不高亮；
// 同时让外层 <pre> 带 'mermaid' 标记，Worker 只吐 <pre class="mermaid"> 占位，
// 由渲染进程 MermaidBlock 取 block.raw 懒渲染（§4.4 / 设计 §3.1）。
const rehypeMermaidRename = () => (tree: any) => {
  const walk = (n: any, parent?: any) => {
    if (
      n.tagName === 'code' &&
      Array.isArray(n.properties?.className) &&
      n.properties.className.includes('language-mermaid')
    ) {
      n.properties.className = ['mermaid'] // 占位 class，脱离 shiki 高亮
      n.properties.dataMermaid = '' // 打 data 属性（供 classify 识别）
      if (parent?.tagName === 'pre') {
        parent.properties.className = ['mermaid'] // 供 classify 识别
        parent.properties.dataMermaid = ''
      }
    }
    n.children?.forEach?.((c: any) => walk(c, n))
  }
  walk(tree)
}

// ─── 自定义 rehype 步骤：相对 img.src 改写为 appdoc://<docId>/<相对路径> ───
// 外链 https:/data:/appdoc: 不动。改写对象仅是 hast 的 img.src 属性，绝不改 markdown 源。
// docId 经 VFile.data 传入，不冻结进处理器（见 §4.2）。
const rehypeImgRewrite = () => (tree: any, file: any) => {
  const docId: string | undefined = file?.data?.docId
  const visit = (n: any) => {
    if (n.tagName === 'img' && typeof n.properties?.src === 'string') {
      const src: string = n.properties.src
      if (/^(https?:|data:|appdoc:)/i.test(src)) return
      const rel = src.replace(/^\.\//, '')
      if (docId) n.properties.src = `appdoc://${docId}/${rel}`
    }
    n.children?.forEach?.((c: any) => visit(c))
  }
  visit(tree)
}

// ─── 自定义 remark 步骤：把 directive 节点转为 <div class="name"> ───
// 替代 remark-directive-rehype：后者会把指令名当元素标签（:::note → <note>），
// 而 <note> 不是标准 HTML 标签，会被 rehype-sanitize 整段剥离，导致自定义容器丢失。
// 这里改为产出 <div class="note">（textDirective 用 <span>），使 classify 的
// directive 识别生效，且 div/span 为标准标签可被净化保留（设计 §3.1 / G10）。
const remarkDirectiveToDiv = () => (tree: any) => {
  const visit = (node: any) => {
    if (
      node.type === 'containerDirective' ||
      node.type === 'leafDirective' ||
      node.type === 'textDirective'
    ) {
      const data = node.data || (node.data = {})
      data.hName = node.type === 'textDirective' ? 'span' : 'div'
      const hProperties: Record<string, any> = { ...(data.hProperties || {}) }
      // 收集 class：显式 class 属性 + 指令名兜底
      const classes: string[] = []
      const rawClass = (node.attributes && node.attributes.class) || hProperties.class
      if (typeof rawClass === 'string') classes.push(...rawClass.split(/\s+/).filter(Boolean))
      else if (Array.isArray(rawClass)) classes.push(...rawClass)
      classes.push(node.name)
      hProperties.className = classes
      // 透传其余指令属性（class 已处理，跳过）
      if (node.attributes) {
        for (const [k, v] of Object.entries(node.attributes)) {
          if (k !== 'class') hProperties[k] = v
        }
      }
      data.hProperties = hProperties
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
}

// ─── 自定义 rehype 步骤：把字符串 class 归一化为 className 数组 ───
// remark-github-alerts 等插件在 hProperties 写入字符串 class（如
// "markdown-alert markdown-alert-note"），经 remark-rehype 后变为
// properties.class（字符串）。hast-util-sanitize 只认 className（数组），
// 会整段剥离 class。这里在净化前归一化，确保 alert 等 class 被保留（BUG-2）。
const rehypeClassNormalize = () => (tree: any) => {
  const visit = (n: any) => {
    if (n.properties && typeof n.properties.class === 'string') {
      n.properties.className = n.properties.class.split(/\s+/).filter(Boolean)
      delete n.properties.class
    }
    n.children?.forEach?.(visit)
  }
  visit(tree)
}

// ─── 处理器（仅构建一次，跨文档复用） ───
const mdastProc: any = (unified() as any)
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath) // 默认 singleDollarTextMath:true，支持行内 $...$
  .use(remarkMathSpaceGuard)
  .use(remarkDirective)
  .use(remarkDirectiveToDiv)
  .use(remarkGithubAlerts)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .freeze()

const hastProc: any = (unified() as any)
  // allowDangerousHtml: 让 remark-rehype 把内嵌 HTML 暂存为 raw 节点，
  // 交由随后的 rehype-raw 解析进 hast 树；末位 rehype-sanitize 仍是单点净化
  // chokepoint（白名单剥离 on*/script/javascript:），故 XSS 不直透（设计 §8 顺序铁律）。
  .use(remarkRehype, { allowDangerousHtml: true })
  // 必须位于 rehype-sanitize 之前、rehypeImgRewrite 之前：先入树才能被净化，
  // 且让 raw HTML 内的 <img> 也能被改写为 appdoc://（本地图正常加载）。
  .use(rehypeRaw)
  .use(rehypeImgRewrite)
  .use(rehypeKatex, { throwOnError: false })
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings)
  .use(rehypeMermaidRename)
  .use(rehypePrettyCode, {
    theme: { light: 'github-light', dark: 'github-dark' },
    keepBackground: false,
    ignoreMissing: true,
  })
  .use(rehypeClassNormalize)
  .use(rehypeSanitize, sanitizeSchema)
  .freeze()

// 稳定字符串哈希（djb2 风格），用于块 id / mermaid 缓存键。
export function hashCode(s: string): string {
  let h = 0
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

const hasClass = (n: any, c: string) =>
  Array.isArray(n?.properties?.className) && n.properties.className.includes(c)

const findInTree = (n: any, pred: (x: any) => boolean): boolean =>
  pred(n) || (Array.isArray(n?.children) && n.children.some((c: any) => findInTree(c, pred)))

// directive 容器识别：前缀匹配（markdown-alert-* / directive-*）+ 裸名精确兜底。
const DIRECTIVE_BARE = ['warning', 'note', 'tip', 'caution', 'important']
const isDirectiveNode = (x: any): boolean =>
  Array.isArray(x?.properties?.className) &&
  x.properties.className.some(
    (cls: string) =>
      cls.startsWith('markdown-alert-') ||
      cls.startsWith('directive-') ||
      DIRECTIVE_BARE.includes(cls)
  )

const classify = (node: any): 'mermaid' | 'directive' | 'normal' => {
  // 优先查 mermaid（含 figure>pre.mermaid 包裹场景），优先查 data-mermaid。
  if (
    findInTree(
      node,
      (x) => x.tagName === 'pre' && (hasClass(x, 'mermaid') || x.properties?.dataMermaid != null)
    )
  ) {
    return 'mermaid'
  }
  if (findInTree(node, isDirectiveNode)) return 'directive'
  return 'normal'
}

// 从 hast 节点抽取 mermaid 源码（兜底）。定位 pre.mermaid / [data-mermaid]，
// 拼接其 <code> 文本。当 mdast 位置配对失效时仍能正确取到源码，避免空 raw
// 触发 “Mermaid 渲染失败：No diagram type detected”（纵深防护，与 classify 同源判定）。
const extractMermaidCode = (node: any): string | undefined => {
  let pre: any = null
  const walk = (n: any) => {
    if (pre) return
    if (n.tagName === 'pre' && (hasClass(n, 'mermaid') || n.properties?.dataMermaid != null)) {
      pre = n
      return
    }
    n.children?.forEach?.(walk)
  }
  walk(node)
  if (!pre) return undefined
  let text = ''
  const collect = (n: any) => {
    if (typeof n.value === 'string') text += n.value
    n.children?.forEach?.(collect)
  }
  collect(pre)
  return text || undefined
}

// 解析 Markdown 为块数组（设计 §4.2）。docId 为当前文档 id（用于 appdoc: 图片重写）。
//
// 性能关键：整树单次 run（而非“逐块 run”）。原实现对每个顶层块都跑一遍完整
// unified 管线（rehype-raw → katex → slug → autolink → mermaidRename →
// ★rehype-pretty-code/shiki★ → sanitize），N 个块 = N 次管线固定开销，且 shiki
// 高亮器被反复拉起，是大文档解析慢的主因。改为整树跑一次：管线固定开销仅付一次，
// shiki/katex 在单次会话内完成；随后按顶层 hast 节点切分块，块形状（id/html/type/
// startLine/endLine）与逐块法完全一致，<Block> 增量 diff 与滚动同步不受影响。
// 单点净化（C1）仍成立：rehype-sanitize 仍是管线末位、仅一次。引用定义 / 脚注定义
// 本就在整树内，单遍中自然解析（R7），无需再逐块并入（旧写法还会把脚注区重复产出）。
export async function buildBlocks(content: string, docId: string | null): Promise<Block[]> {
  const mdastRoot: any = await mdastProc.run(mdastProc.parse(content))

  const file = new VFile()
  file.data.docId = docId
  // 整树单次管线：引用 / 脚注在单遍中解析，净化仅一次。
  const clean: any = await hastProc.run(mdastRoot, file)

  const mdChildren: any[] = mdastRoot.children
  const blocks: Block[] = []
  // 按 startLine 建立 mdast 节点索引，供 hast 元素节点精确配对（见下方说明）。
  // 不产生内联输出的顶层 mdast 节点（frontmatter / 引用定义 / 脚注定义）在
  // remark-rehype 后无对应 hast 子节点，自然不会参与配对。
  const mdByLine = new Map<number, any>()
  for (const n of mdChildren) {
    const line = n.position?.start.line
    if (typeof line === 'number') mdByLine.set(line, n)
  }

  // 按顶层 hast 节点切分块。注意不能按“索引”把 hast 子节点与 mdast 子节点
  // 一一对应：开启 rehype-raw（allowDangerousHtml）后，remark-rehype 会在块间
  // 插入空白 text 节点（如 '\n'）；脚注定义会被收拢为末尾一个 <section>。这些
  // 节点无 position，若按索引配对会把 mermaid 的 <pre> 错位配到 m=null，导致
  // raw 为空 → “Mermaid 渲染失败：No diagram type detected”。
  // 改为：仅对“元素节点”配对，且用 startLine 在 mdast 中精确查找源节点
  // （元素节点的 position 经整条管线 + sanitize 后依然保留，与源 mdast 对齐）。
  for (const hNode of clean.children) {
    if (hNode.type !== 'element') continue // 跳过空白 text / comment 节点
    const line = hNode.position?.start.line
    const m = typeof line === 'number' ? mdByLine.get(line) ?? null : null
    const startLine = m?.position?.start.line ?? 0
    const endLine = m?.position?.end.line ?? 0
    const raw = m?.type === 'code' ? (m as { value: string }).value : undefined
    const html = toHtml(hNode)
    const type = classify(hNode)
    // mermaid 源码优先取 mdast 原文（位置配对），配对失效时从渲染后的
    // pre.mermaid 抽取兜底，确保 raw 永不为空（见 extractMermaidCode）。
    const mermaidRaw = type === 'mermaid' ? (raw ?? extractMermaidCode(hNode) ?? '') : undefined
    blocks.push({
      id: `b${blocks.length}-${hashCode(html)}`,
      html,
      type,
      raw: mermaidRaw,
      startLine,
      endLine,
    })
  }

  // 全文仅 frontmatter（无正文块）→ 退回整篇单块。
  if (blocks.length === 0) {
    blocks.push({
      id: 'b0-full',
      html: toHtml(clean),
      type: 'normal',
      startLine: 0,
      endLine: 0,
    })
  }

  return blocks
}
