// 导出用“净化后预览 HTML”单一数据源（非响应式单例，避免 store 抖动）。
// MarkdownPreview 在解析完成后写入；导出时直接读取，复用同一份已净化、
// 已注入 Mermaid/KaTeX 的 HTML，保证所见即所得且不为导出重写渲染逻辑（R7）。
let current = ''

export function setExportHtml(html: string): void {
  current = html
}

export function getExportHtml(): string {
  return current
}
