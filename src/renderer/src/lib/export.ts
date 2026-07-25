// 导出编排（R7）：复用预览“净化后 HTML”单一数据源，拼装独立 .html 文件。
// 仅负责 CSS/主题内联与图片策略，不重写任何 Markdown 渲染逻辑（渲染在 MarkdownPreview 完成）。
import githubCss from 'github-markdown-css/github-markdown.css?raw' // 浅色
import githubDarkCss from 'github-markdown-css/github-markdown-dark.css?raw' // 暗色
import katexCss from 'katex/dist/katex.min.css?raw'
import { getExportHtml } from './exportStore'

// 解析最终导出/打印主题：'current' 跟随 UI 主题；'system' 经 matchMedia 取真实深/浅色。
// 抽出为共用函数，避免打印（App.tsx）与导出 HTML（ExportDialog）对 system 主题解析不一致。
export function resolveTheme(
  choice: 'current' | 'light' | 'dark',
  uiTheme: string
): 'light' | 'dark' {
  if (choice !== 'current') return choice
  if (uiTheme === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return uiTheme === 'dark' ? 'dark' : 'light'
}

// 拼装独立 HTML（与导出 HTML 同一逻辑）。PDF 与 HTML 导出共用此函数，
// 同时收尾 D1 命名（计划原称 buildStandaloneHtml）。
// 导出统一为 UTF-8：meta charset 固定 utf-8，与 writeFileSync(..., 'utf-8') 字节一致，
// 避免非 UTF-8 文档（GBK/Big5 等）导出后浏览器按原编码误读导致乱码（R5 导出字节保真）。
export async function buildStandaloneHtml(opts: {
  theme: 'light' | 'dark'
  embedImages: boolean
}): Promise<string> {
  let body = getExportHtml()
  if (opts.embedImages) {
    // 图片内联为 base64 单文件（离线可用）；失败则保留原 src。
    body = await window.api.export.embedImages(body)
  } else {
    // 非内联：appdoc:// 还原为相对路径（配套 images/ 分发），远程 https 保留。
    body = body.replace(/src="appdoc:\/\/[^/]+\/([^"]+)"/g, (_m, p1) => `src="${decodeURIComponent(p1)}"`)
  }
  const css = opts.theme === 'dark' ? githubDarkCss : githubCss
  return `<!doctype html>
<html lang="zh-CN" data-theme="${opts.theme}" data-color-mode="${opts.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exported Markdown</title>
<style>${css}</style>
<style>${katexCss}</style>
<style>
body{padding:24px;max-width:980px;margin:0 auto;}
@media print{
  /* 打印时与预览（Tailwind prose）保持一致：标题不带下边框 */
  .markdown-body h1,.markdown-body h2{border-bottom:none;padding-bottom:0;}
  /* GitHub 样式用 ::before/::after 做 clearfix，某些打印引擎会在页首生成细线，打印时关闭 */
  .markdown-body::before,.markdown-body::after{display:none;content:none;}
  /* hr 在打印时恢复为 GitHub 默认的实心灰条（0.25em 背景色填充），
     因为 1px 透明浅灰边框在打印 PDF / 系统打印对话框默认不打印背景时几乎不可见。
     使用 print-color-adjust: exact 强制 Chromium 打印该背景色，避免 hr 消失。 */
  .markdown-body hr{
    display:block;
    height:0.25em;
    margin:1.5em 0;
    padding:0;
    background:var(--borderColor-default);
    border:0;
    overflow:hidden;
    break-inside:avoid;
    page-break-inside:avoid;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }
  .markdown-body hr::before,.markdown-body hr::after{display:none !important;content:none !important;}
}
</style>
</head>
<body class="markdown-body">
${body}
</body>
</html>`
}

export async function exportDocument(opts: {
  path: string
  theme: 'light' | 'dark'
  embedImages: boolean
}): Promise<void> {
  const html = await buildStandaloneHtml({ theme: opts.theme, embedImages: opts.embedImages })
  await window.api.export.write(opts.path, html)
}
