// Fixture mirror of the action's user block plugin `types` (see
// .github/create-pr/blocks/types.mjs). It exists so render.test.mjs can load a
// real plugin via loader.mjs's dynamic import() against a test asset and assert
// the rendered body contains the plugin output — preserving the end-to-end
// "template placeholder ⇄ plugin" alignment check WITHOUT touching the real
// repository filesystem. Signature mirrors the canonical plugin:
// `export default (ctx) => string`, reading `ctx.typeFlags`.
export default function types(ctx) {
  const flags = (ctx && ctx.typeFlags) || {}
  const row = (label, on) => `- [${on ? 'x' : ' '}] ${label}`
  return [
    row('Bug fix (non-breaking change which fixes an issue)', flags.bug),
    row('New feature (non-breaking change which adds functionality)', flags.feature),
    row(
      'Breaking change (fix or feature that would cause existing functionality to not work as expected)',
      flags.breaking,
    ),
    row('Documentation update', flags.docs),
  ].join('\n')
}
