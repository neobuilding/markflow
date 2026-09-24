// Built-in block plugin: `issue` (matches the `{{issue}}` placeholder in the
// PR template).
//
// Renders the linked issue number. It is AUTONOMOUS (the plugin-autonomy
// contract): it pulls the raw commit data itself from `ctx.services.git.logSubjects`
// and extracts the issue number via `extractFixes`, rather than relying on the
// caller to pre-compute and stuff a `ctx.fixes` value. The renderer/orchestrator
// therefore never has to know "which plugin needs the issue number". When no
// issue is referenced, it returns `N/A` — the empty-value presentation is the
// plugin's own responsibility, not the renderer's.
//
// Form: `export default (ctx) => string | Promise<string>` the single shared
// plugin contract, used by both built-in blocks and user-provided blocks.

// Inlined so this built-in plugin owns ALL of its logic and depends on no core
// classification module (the action core contains NO classification code).
function extractFixes(head, commitsText = '') {
  const hay = `${head}\n${commitsText}`
  const m = hay.match(/#(\d+)/)
  return m ? m[1] : ''
}

export default async function issue(ctx) {
  const services = (ctx && ctx.services) || {}
  const git = services.git
  let commitsText = ''
  if (git && typeof git.logSubjects === 'function') {
    try {
      commitsText = (await git.logSubjects(ctx.head || '', ctx.base || 'main')) || ''
    } catch {
      commitsText = ''
    }
  }
  const fixes = extractFixes((ctx && ctx.head) || '', commitsText)
  return fixes ? fixes : 'N/A'
}
