// Fixture mirror of the action's user block plugin `types` (see
// .github/create-pr/blocks/types.mjs). It lives next to the user-plugin tests so
// the unit suite can load a real plugin via loader.mjs's dynamic import() against
// a test asset and assert the rendered body contains the plugin output,
// preserving the end-to-end "template placeholder ⇄ plugin" alignment check
// WITHOUT touching the real repository filesystem.
//
// It inlines `classifyChange` (a self-contained copy of the user plugin's
// classification logic) so it needs no core module — the action core contains NO
// classification code. The repo-side plugin is the canonical source; keep the two
// in lock-step (guarded by plugin-sync.test.mjs). `classifyChange` is also
// exported so the classifyChange unit tests can import it directly.
//
// Form: `export default (ctx) => string | Promise<string>`, reading the branch
// name and commit subjects via `ctx.services.git`.

// Inlined classification (standalone copy keep in sync with
// .github/create-pr/blocks/types.mjs).
const BRANCH_TYPE_KEYS = {
  fix: 'bug',
  feature: 'feature',
  refactor: 'refactor',
  test: 'test',
  perf: 'improvement',
  ci: 'improvement',
  build: 'improvement',
  chore: 'improvement',
  docs: 'docs',
}
const COMMIT_TYPE_KEYS = {
  fix: 'bug',
  feat: 'feature',
  refactor: 'refactor',
  test: 'test',
  perf: 'improvement',
  ci: 'improvement',
  build: 'improvement',
  chore: 'improvement',
  docs: 'docs',
}
export function classifyChange(head, commitsText) {
  const flags = {
    bug: false,
    feature: false,
    refactor: false,
    test: false,
    improvement: false,
    docs: false,
    breaking: false,
  }
  const prefix = (head || '').split('/')[0].toLowerCase()
  const branchKey = BRANCH_TYPE_KEYS[prefix]
  if (branchKey) flags[branchKey] = true
  const commitTypeRe = /^(?:- )?(\w+)(?:\([^)]*\))?(!)?:/
  for (const line of (commitsText || '').split('\n')) {
    const m = line.toLowerCase().match(commitTypeRe)
    if (!m) continue
    const key = COMMIT_TYPE_KEYS[m[1]]
    if (key) flags[key] = true
    if (m[2] === '!') flags.breaking = true
  }
  if (/break|breaking/.test(`${head}\n${commitsText}`)) flags.breaking = true
  const workTypes = [
    flags.bug,
    flags.feature,
    flags.refactor,
    flags.test,
    flags.improvement,
    flags.docs,
  ]
  if (!workTypes.some(Boolean)) flags.bug = true
  return flags
}

export default async function types(ctx) {
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
  const flags = classifyChange(ctx.head || '', commitsText)
  const row = (label, on) => `- [${on ? 'x' : ' '}] ${label}`
  return [
    row('Bug fix (non-breaking change which fixes an issue)', flags.bug),
    row('New feature (non-breaking change which adds functionality)', flags.feature),
    row('Refactor (code change that neither fixes a bug nor adds a feature)', flags.refactor),
    row('Tests (adding or updating tests)', flags.test),
    row(
      'Performance / technical improvement (perf, CI, build, chore, or other internal improvement)',
      flags.improvement,
    ),
    row('Documentation update', flags.docs),
    row(
      'Breaking change (fix or feature that would cause existing functionality to not work as expected)',
      flags.breaking,
    ),
  ].join('\n')
}
