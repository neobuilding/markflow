// Forced sanitization gate component: every preview HTML injection must go through this
// component, ensuring it passes through sanitizeHtml exactly once. Directly calling
// dangerouslySetInnerHTML with an unsanitized string becomes impossible at the code level
// (replacing the original PLAN's doc/CI guardrails).
import React from 'react'
import { sanitizeHtml } from '../lib/sanitize'

export function SafeHtml({
  html,
  className,
}: {
  html: string
  className?: string
}): React.ReactElement {
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
}
