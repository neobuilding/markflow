// Create (or refresh) a Pull Request for a branch against `main`.
//
// This is the SINGLE source of truth for PR automation, shared by both:
//   - the local `npm run pr` command (scripts/create-pr.mjs, run on a dev machine)
//   - the CI workflow `.github/workflows/auto-pr.yml` (which simply calls this
//     script with --head set to the pushed branch)
//
// Behaviour:
//   - Pushes the head branch to origin (sets upstream on first push).
//   - Opens a PR via the GitHub CLI (`gh`), using the repo's PR template
//     (.github/pull-request-template.md).
//   - Idempotent: if a PR for the head branch already exists, it is NOT
//     re-created; instead its description is refreshed to reflect the latest
//     commits on the branch. The template/manually-written content above the
//     generated "## Commits" marker is preserved; only the commit list is
//     regenerated. Re-running on the same commits is a no-op.
//   - Derives the PR title from the branch name (feature/*, fix/*, etc.).
//
// Requirements:
//   - `gh` CLI installed and authenticated (`gh auth login` locally, or
//     GITHUB_TOKEN in CI).
//   - Run inside a git worktree with a remote named `origin`.
//
// Usage:
//   node scripts/create-pr.mjs                       # current branch -> main
//   node scripts/create-pr.mjs --base dev            # target a different base
//   node scripts/create-pr.mjs --head feature/foo    # explicit head (CI)
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  if (i !== -1 && args[i + 1]) return args[i + 1]
  return fallback
}

const BASE = arg('--base', 'main')
const TEMPLATE = '.github/pull-request-template.md'

// Marker delimiting the auto-generated commit list inside a PR body.
const COMMITS_MARKER = '## Commits'

// Run a command, returning trimmed stdout. Throws on non-zero exit.
function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim()
}

// Run a command, returning null on non-zero exit instead of throwing.
function tryRun(cmd, cmdArgs, opts = {}) {
  try {
    return run(cmd, cmdArgs, opts)
  } catch {
    return null
  }
}

function fail(msg) {
  console.error(`create-pr: ${msg}`)
  process.exit(1)
}

// Resolve the head branch: explicit --head, else the current branch.
function resolveHead() {
  const explicit = arg('--head')
  if (explicit) return explicit
  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    fail('not on a branch (detached HEAD?) and no --head given. Cannot create a PR.')
  }
  return branch
}

// Build the "## Commits" section from commits on head that are not in base.
// Exported for unit testing. The git-log executor can be injected (gitLogFn)
// so tests run without a real repository; it defaults to the real `git log`.
export function buildCommitsSection(
  head,
  base,
  gitLogFn = (h, b) =>
    tryRun('git', ['log', '--no-merges', '--pretty=format:- %h %s', `${b}..${h}`]),
) {
  const log = gitLogFn(head, base)
  if (!log) return ''
  return `${COMMITS_MARKER}\n\n${log}\n`
}

// Replace (or append) the generated commits section, preserving content above
// the marker. Deterministic: same commits => same output (idempotent).
// Exported for unit testing.
export function refreshCommitsSection(body, commitsSection) {
  if (!commitsSection) return body
  const stripped = body.includes(COMMITS_MARKER)
    ? body.slice(0, body.indexOf(COMMITS_MARKER))
    : body
  return stripped.replace(/\s+$/, '') + '\n\n' + commitsSection
}

// Derive a human-readable title from a branch name. Exported for unit testing.
export function deriveTitle(branch) {
  return branch
    .replace(/^(feature|fix|feat|chore|docs|refactor|test|build|ci)\//i, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

// ── Main (only runs when executed directly, not when imported by tests) ──
async function runMain() {
  const head = resolveHead()

  const ghVersion = tryRun('gh', ['--version'])
  if (!ghVersion) {
    fail("GitHub CLI ('gh') is not installed or not on PATH. Install: https://cli.github.com/")
  }

  const remotes = run('git', ['remote']).split('\n').filter(Boolean)
  if (!remotes.includes('origin')) {
    fail("no 'origin' remote configured. Add one with: git remote add origin <url>")
  }

  // Fetch base so the commit diff is accurate (local CI checkout may be shallow).
  // Non-fatal: if offline / no permission, warn but continue with whatever local
  // base ref we have — the generated commit list may then be approximate.
  const fetched = tryRun('git', ['fetch', 'origin', BASE, '--quiet'])
  if (fetched === null) {
    console.warn(
      `create-pr: warning: could not fetch '${BASE}' from origin; ` +
        'the commit list may be based on a stale local ref.',
    )
  }

  // Idempotency: find an existing open PR for this head -> base.
  const existing = tryRun('gh', [
    'pr',
    'list',
    '--head',
    head,
    '--base',
    BASE,
    '--state',
    'open',
    '--json',
    'number,url,body',
  ])
  let existingPrs
  try {
    existingPrs = existing ? JSON.parse(existing) : []
  } catch {
    existingPrs = []
  }

  if (existingPrs.length > 0) {
    const { number, url, body = '' } = existingPrs[0]
    const newBody = refreshCommitsSection(body, buildCommitsSection(head, BASE))
    if (newBody === body) {
      console.log(`create-pr: PR already up to date for ${head} → ${BASE}: ${url}`)
      process.exit(0)
    }
    if (tryRun('gh', ['pr', 'edit', String(number), '--body', newBody]) === null) {
      fail(`failed to update the existing PR description: ${url}`)
    }
    console.log(`create-pr: updated PR description with latest commits: ${url}`)
    process.exit(0)
  }

  // No existing PR: push and create.
  console.log(`create-pr: pushing '${head}' to origin...`)
  if (tryRun('git', ['push', '-u', 'origin', head]) === null) {
    fail(
      `failed to push '${head}' to origin. Check your network/auth and that the branch does not have divergent history.`,
    )
  }

  const title = deriveTitle(head)
  const commitsSection = buildCommitsSection(head, BASE)
  let templateBody
  try {
    templateBody = readFileSync(TEMPLATE, 'utf8').trimEnd()
  } catch {
    templateBody = ''
  }
  const body = (templateBody ? templateBody + '\n\n' : '') + commitsSection

  console.log(`create-pr: creating PR '${head}' → ${BASE} ...`)
  const out = tryRun('gh', [
    'pr',
    'create',
    '--base',
    BASE,
    '--head',
    head,
    '--title',
    title || head,
    '--body',
    body,
  ])
  if (out === null) {
    // A concurrent run may have just created it; treat as success if present.
    const concurrent = tryRun('gh', [
      'pr',
      'list',
      '--head',
      head,
      '--base',
      BASE,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url // empty',
    ])
    if (concurrent) {
      console.log(`create-pr: PR created concurrently: ${concurrent}`)
      process.exit(0)
    }
    fail('failed to create the PR. Run `gh pr create` manually to inspect the error.')
  }
  console.log(`create-pr: created PR → ${out}`)
}

// Execute only when run as a script (e.g. `node scripts/create-pr.mjs` or via
// the `npm run pr` / CI workflow), not when imported by unit tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runMain()
}
