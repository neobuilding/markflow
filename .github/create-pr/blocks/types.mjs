// Markflow's custom block plugin: `types`.
//
// This is the canonical example of the "built-in and user blocks are the SAME
// plugin shape" design: it lives in the *user* repo (`.github/create-pr/blocks/`)
// rather than inside the action, and is loaded by the exact same directory-scan
// mechanism as the action's built-in blocks. The action core never hard-codes
// any "Type of Change" wording, and since the refactor it also never computes
// the PR type: this plugin derives the `typeFlags` itself from `ctx.head` and
// `ctx.services.git.logSubjects` (plugin-autonomy). Any repo can supply its own
// `types.mjs` with different wording/dimensions.
//
// Form: `export default (ctx) => string | Promise<string>`. It reads the branch
// name and commit subjects (via the injected, memoized git service) and renders
// the full `- [x]/[ ]` checkbox lines. The taxonomy below mirrors markflow's
// branch taxonomy (see `auto-pr.yml`): the work-type boxes follow the branch
// prefixes, and `breaking` is an overlay that can sit on top of any work-type
// box. The `improvement` box aggregates the non-user-facing internal work types
// (perf / ci / build / chore) into one "Performance / technical improvement"
// entry.
//
// NOTE: `classifyChange` is inlined here (rather than imported) so this plugin
// stays a standalone, user-editable file that the action can load from an
// arbitrary repo without bundling `src/`. This file is the canonical source of
// the classification; the test fixture
// `.github/create-pr/blocks/__tests__/fixtures/types.mjs` mirrors it (keep the two
// in lock-step). The action core contains NO classification module.
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

// --- inlined classifyChange (standalone copy; keep in sync with the test fixture
//     .github/create-pr/blocks/__tests__/fixtures/types.mjs) ---
function classifyChange(head, commitsText) {
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
