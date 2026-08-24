// Built-in block plugin: `issue` (matches the `{{issue}}` placeholder in the
// PR template).
//
// Renders the linked issue number from `ctx.fixes` (already derived by
// `buildCtx` via `extractFixes`). When no issue is referenced, it returns
// `N/A` — the empty-value presentation is the plugin's own responsibility, not
// the renderer's (the renderer never inserts a fallback).
//
// Form: `export default (ctx) => string` — the single shared plugin contract
// used by both built-in blocks (this directory) and user-provided blocks.
export default function issue(ctx) {
  return ctx.fixes ? ctx.fixes : 'N/A'
}
