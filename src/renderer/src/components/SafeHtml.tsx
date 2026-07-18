// 强制净化关卡组件：所有预览 HTML 注入必须经此组件，确保经 sanitizeHtml 单次净化。
// 直接 `dangerouslySetInnerHTML` 未净化串在代码层面不可能出现（替代原 PLAN 的文档/CI 护栏）。
import React from 'react'
import { sanitizeHtml } from '../lib/sanitize'

export function SafeHtml({
  html,
  className,
}: {
  html: string
  className?: string
}): React.ReactElement {
  return (
    <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
  )
}
