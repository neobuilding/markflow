// Built-in block plugin: `title`.
//
// Renders the PR title, preferring `ctx.title` (which `buildCtx` already
// derived from the branch name) and falling back to deriving it from `ctx.head`
// directly. When the title is empty, it outputs an empty string (the caller's
// surrounding markup such as `# {{title}}` then degrades to `# `).
//
// This plugin is intentionally self-contained (no import of core.mjs) so it
// can be copied verbatim into `dist/blocks/` and loaded at runtime by the
// directory scanner, independent of how the action is bundled.
//
// Form: `export default (ctx) => string` — the single shared plugin contract
// used by both built-in blocks (this directory) and user-provided blocks.

// Mirrors core.deriveTitle so the plugin stays standalone in dist/blocks.
function deriveTitle(branch) {
  return branch
    .replace(/^(feature|fix|feat|chore|docs|refactor|test|build|ci)\//i, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

export default function title(ctx) {
  if (ctx.title !== undefined) return ctx.title
  return deriveTitle(ctx.head || '')
}
