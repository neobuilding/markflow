// Built-in block plugin: `commits`.
//
// Renders the `base..HEAD` commit list body. This plugin is AUTONOMOUS: it pulls
// the commit list itself from `ctx.services.git.logRange(head, base)` instead of
// relying on the caller to pre-compute and stuff a `ctx.commits` value. That is
// the plugin-autonomy contract — a block fetches whatever data it needs from
// `ctx.services`, so the renderer/orchestrator never has to know "which plugin
// needs which data".
//
// `ctx.services` is injected by buildCtx (see render.mjs). When no git service
// is available (e.g. the `--no-git` CLI mode, or a test that passes no services)
// the plugin renders '' gracefully.
//
// Form: `export default (ctx) => string` — the single shared plugin contract.
export default function commits(ctx) {
  const services = (ctx && ctx.services) || {}
  const git = services.git
  if (!git) return ''
  try {
    const log = git.logRange(ctx.head || '', ctx.base || 'main')
    return log ? `${log}\n` : ''
  } catch {
    return ''
  }
}
