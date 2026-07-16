// Worker 内 rehype-sanitize 的 schema（设计 §5.1 / 附录 A）。
// 基于 hast-util-sanitize 的 defaultSchema，放行 shiki/KaTeX 需要的
// className/style/id，放行 appdoc:/data:/https: 图片协议，封死 on* 与
// javascript:，并放行 KaTeX 的 MathML 无障碍层与 rehype-pretty-code 的
// data-* 钩子（标题栏/行号/高亮行/明暗切换变量）。
import { defaultSchema, type Schema } from 'hast-util-sanitize'

// 结构化克隆默认 schema，避免污染共享对象。
const schema: Schema = structuredClone(defaultSchema)

// 放行所有元素上的 className / style / id（shiki 内联 style、标题锚点 id）。
schema.attributes!['*'] = [
  ...(schema.attributes!['*'] ?? []),
  'className',
  'style',
  'id',
]

// 协议白名单：封死 javascript:；图片允许 appdoc:/data:/https:（外链合法图）。
schema.protocols = {
  ...defaultSchema.protocols,
  href: ['http', 'https', 'mailto'],
  src: ['http', 'https', 'appdoc', 'data'],
}

// 放行 KaTeX 的 MathML 无障碍层（屏幕阅读器可读公式）。
const mathmlTags = [
  'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mfrac',
  'msqrt', 'mroot', 'msup', 'msub', 'msubsup', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'annotation',
  'annotation-xml', 'mpadded', 'mphantom', 'menclose', 'mglyph', 'mspace',
  'mlabeledtr', 'mlongdiv', 'mscarries', 'mscarry', 'msgroup', 'mstack',
  'maction', 'none',
]
schema.tagNames!.push(...mathmlTags)

// 放行 rehype-pretty-code 的 <figure>/<figcaption> 容器（代码块标题栏），
// 以及 KaTeX 的 <svg>/<path>（根号/拉伸符号等以 SVG 绘制，defaultSchema 不含这些
// 标签会被整段剥离，导致公式渲染残缺；实测 KaTeX 仅用 xmlns/width/height/
// viewBox/preserveAspectRatio/d 等惰性属性，无脚本/外链风险）。
schema.tagNames!.push('figure', 'figcaption', 'svg', 'path')
schema.attributes!['svg'] = [
  ...(schema.attributes!['svg'] ?? []),
  'xmlns',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
]
schema.attributes!['path'] = [...(schema.attributes!['path'] ?? []), 'd']

schema.attributes!['math'] = [
  ...(schema.attributes!['math'] ?? []),
  'xmlns', 'display', 'encoding', 'mathvariant',
]
schema.attributes!['annotation'] = [
  ...(schema.attributes!['annotation'] ?? []),
  'encoding',
]
schema.attributes!['annotation-xml'] = [
  ...(schema.attributes!['annotation-xml'] ?? []),
  'encoding', 'xlinkHref',
]
schema.attributes!['mi'] = [...(schema.attributes!['mi'] ?? []), 'mathvariant']
schema.attributes!['mo'] = [...(schema.attributes!['mo'] ?? []), 'mathvariant']
schema.attributes!['mn'] = [...(schema.attributes!['mn'] ?? []), 'mathvariant']
schema.attributes!['ms'] = [...(schema.attributes!['ms'] ?? []), 'mathvariant']
schema.attributes!['mtext'] = [...(schema.attributes!['mtext'] ?? []), 'mathvariant']

// KaTeX 部分 MathML 输出含 xlink:href（hast 属性名为驼峰 xlinkHref）。
schema.attributes!['*'] = [
  ...(schema.attributes!['*'] ?? []),
  'xlinkHref',
  'aria-hidden',
  'role',
]

// 放行 rehype-pretty-code 产出的 data-* 属性（标题栏/行号/高亮行/css 变量钩子）
// 以及 rehypeMermaidRename 打的 data-mermaid（使 classify 在 sanitize 后仍生效）。
//
// ⚠️ 关键：hast-util-sanitize 的属性名校验用的是 hast 驼峰属性名（如 dataMermaid /
// dataRehypePrettyCodeFigure），而非 HTML 连字符名（data-mermaid）。且只有属性表里
// 显式存在 'data*' 通配项时，findDefinition 才会把任意 dataXxx 归属到该通配项。
// 因此这里必须用 'data*' 通配，逐个列出连字符名会被精确匹配判定为不合法而全部剥离。
schema.attributes!['*'] = [...(schema.attributes!['*'] ?? []), 'data*']

export const sanitizeSchema: Schema = schema
