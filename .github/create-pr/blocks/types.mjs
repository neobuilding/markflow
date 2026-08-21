// Markflow's custom block plugin: `types`.
//
// This is the canonical example of the "built-in and user blocks are the SAME
// plugin shape" design: it lives in the *user* repo (`.github/create-pr/blocks/`)
// rather than inside the action, and is loaded by the exact same directory-scan
// mechanism as the action's built-in blocks. The action core never hard-codes
// any "Type of Change" wording.
//
// Form: `export default (ctx) => string`. It reads `ctx.typeFlags` (derived by
// the action's `classifyChange` in `buildCtx`) and renders the full
// `- [x]/[ ]` checkbox lines. The wording below matches markflow's PR template;
// any repo can supply its own `types.mjs` with different wording/dimensions.
export default function types(ctx) {
  const flags = (ctx && ctx.typeFlags) || {}
  const row = (label, on) => `- [${on ? 'x' : ' '}] ${label}`
  return [
    row('Bug fix (non-breaking change which fixes an issue)', flags.bug),
    row('New feature (non-breaking change which adds functionality)', flags.feature),
    row('Breaking change (fix or feature that would cause existing functionality to not work as expected)', flags.breaking),
    row('Documentation update', flags.docs),
  ].join('\n')
}
