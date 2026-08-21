// Built-in block plugin: `commits`.
//
// Renders the `base..HEAD` commit list body. It uses `ctx.commits` when the
// caller has already computed it (e.g. `buildCtx` passes the result of the
// core's commit-section builder), and otherwise derives it on the fly via
// `git log base..HEAD` — which preserves the injectable `gitLogFn` so tests run
// without a real repo. `ctx.base` is the resolved base ref; `ctx.head` is the
// branch name.
//
// This plugin is intentionally self-contained (no import of core.mjs) so it
// can be copied verbatim into `dist/blocks/` and loaded at runtime by the
// directory scanner, independent of how the action is bundled.
//
// Form: `export default (ctx) => string` — the single shared plugin contract
// used by both built-in blocks (this directory) and user-provided blocks.
import { execFileSync } from 'node:child_process'

export default function commits(ctx) {
  if (ctx.commits !== undefined) return ctx.commits
  const base = ctx.base || 'main'
  const gitLogFn =
    ctx.gitLogFn ||
    ((_h, b) =>
      execFileSync('git', ['log', '--no-merges', '--pretty=format:- %h %s', `${b}..HEAD`], {
        encoding: 'utf8',
      }).trim())
  try {
    const log = gitLogFn(ctx.head || '', base)
    return log ? `${log}\n` : ''
  } catch {
    return ''
  }
}
