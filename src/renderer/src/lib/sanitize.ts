// 单一 XSS 关卡（markdown-render-v2-simple 设计）。
// 全应用预览注入一律经 sanitizeHtml（由 SafeHtml 组件强制调用），
// 使「直接 dangerouslySetInnerHTML 未净化串」在代码层面不可能。
import DOMPurify from 'dompurify'

// 仅放行 code/span/math 元素及所有 SVG 命名空间元素的 style（防 BUG-5 重演）：
// DOMPurify 默认**保留** style，若全量放行，恶意内嵌 HTML 可借 style 做 CSS 外泄
// （属性选择器 + background:url 探测）。其余元素（div/p/a/pre…）的 style 一律剥离。
const STYLE_ALLOWED_TAGS = new Set(['code', 'span', 'math'])
const SVG_NS = 'http://www.w3.org/2000/svg'

DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.nodeType !== 1 /* Element */ || !node.hasAttribute('style')) return
  const tag = node.tagName.toLowerCase()
  if (STYLE_ALLOWED_TAGS.has(tag)) return
  if (node.namespaceURI === SVG_NS) return // mermaid/katex 的 SVG 样式需保留
  node.removeAttribute('style')
})

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // mermaid 占位属性；其余 data-* 由 DOMPurify 默认 ALLOW_DATA_ATTR 放行。
    ADD_ATTR: ['data-mermaid-slot'],
    // 放行 KaTeX / mermaid 需要的 SVG <use> 引用，以及 KaTeX MathML 无障碍层
    // （annotation 携带 TeX 源码，供屏幕阅读器；jsdom 解析器会丢，但 Chromium 保留，
    // 这里显式放行以锁死行为，与原 rehype-sanitize schema 对齐）。
    ADD_TAGS: ['use', 'annotation', 'annotation-xml'],
  })
}
