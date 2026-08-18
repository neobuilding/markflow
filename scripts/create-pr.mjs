// Create (or refresh) a Pull Request for a branch against `main`.
//
// This is the SINGLE source of truth for PR automation, shared by both:
//   - the local `npm run pr` command (scripts/create-pr.mjs, run on a dev machine)
//   - the CI workflow `.github/workflows/auto-pr.yml` (which simply calls this
//     script with --head set to the pushed branch)
//
// Behaviour:
//   - Opens (or refreshes) a PR via the GitHub CLI (`gh`), using the repo's PR
//     template (.github/pull-request-template.md).
//   - Does NOT push. The head branch must already exist on origin; if it does
//     not, the script fails fast with a hint to push it first.
//   - Idempotent: if a PR for the head branch already exists, it is NOT
//     re-created; instead its description is refreshed to reflect the latest
//     commits on the branch. The PR body is partitioned by the
//     AUTO-GENERATED-START .. AUTO-GENERATED-END markers: everything between
//     them (title / description / type of change / tested / commit list /
//     Checklist) is regenerated from the template on every refresh — so the
//     Checklist resets to its template state and must be re-ticked after each
//     push. Anything a human writes OUTSIDE the markers (above START or below
//     END) is preserved. Re-running on the same commits is a no-op.
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
//   node scripts/create-pr.mjs --dry-run             # print the body, write nothing
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
const DRY_RUN = args.includes('--dry-run')
const TEMPLATE = '.github/pull-request-template.md'

// Marker delimiting the auto-generated commit list inside a PR body.
const COMMITS_MARKER = '## Commits'

// Symmetric markers delimiting the auto-generated section in a PR body. The
// script only ever rewrites the text *between* these markers; anything outside
// (above START, or below END) is human-written and preserved across refreshes.
// The template carries both markers; a PR body gains them on first creation,
// after which refreshes are precise (replace between markers only).
const AUTO_GENERATED_START = '<!-- AUTO-GENERATED-START -->'
const AUTO_GENERATED_END = '<!-- AUTO-GENERATED-END -->'

// Extract the auto-generated section (the text between the START and END
// markers, inclusive of the markers) from a body. Returns null when the body
// is not partitioned (no markers yet) so callers can fall back to A2 behaviour.
// Exported for unit testing.
export function extractAutoSection(body) {
  if (!body || !body.includes(AUTO_GENERATED_START) || !body.includes(AUTO_GENERATED_END)) {
    return null
  }
  return body.slice(
    body.indexOf(AUTO_GENERATED_START),
    body.indexOf(AUTO_GENERATED_END) + AUTO_GENERATED_END.length,
  )
}

// Run a command, returning trimmed stdout. Throws on non-zero exit.
// v8 ignore: these process-executing helpers are only reached from runMain
// (external orchestration) and cannot be exercised by the pure unit tests.
/* v8 ignore start */
function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim()
}
/* v8 ignore stop */

// Run a command, returning null on non-zero exit instead of throwing.
/* v8 ignore start */
function tryRun(cmd, cmdArgs, opts = {}) {
  try {
    return run(cmd, cmdArgs, opts)
  } catch {
    return null
  }
}
/* v8 ignore stop */

/* v8 ignore start */
function fail(msg) {
  console.error(`create-pr: ${msg}`)
  process.exit(1)
}
/* v8 ignore stop */

// Resolve the head branch: explicit --head (e.g. CI), else the current branch.
/* v8 ignore start */
function resolveHead() {
  const explicit = arg('--head')
  if (explicit) return explicit
  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    fail('not on a branch (detached HEAD?) and no --head given. Cannot create a PR.')
  }
  return branch
}
/* v8 ignore stop */

// Build the "## Commits" section from commits on head that are not in base.
// Exported for unit testing. The git-log executor can be injected (gitLogFn)
// so tests run without a real repository; it defaults to the real `git log`.
export function buildCommitsSection(
  head,
  base,
  // Use `HEAD` (not the branch name) for the git-log range. In CI, checkout
  // is typically detached, so the local branch name may not exist; HEAD always
  // points to the correct feature-branch tip. Locally, HEAD is the current
  // branch tip, so this is equivalent.
  gitLogFn = (_h, b) =>
    tryRun('git', ['log', '--no-merges', '--pretty=format:- %h %s', `${b}..HEAD`]),
) {
  const log = gitLogFn(head, base)
  if (!log) return ''
  return `${COMMITS_MARKER}\n\n${log}\n`
}

// Build a human-readable commit summary (subjects only, no hashes) for the
// Description section. Exported for unit testing; gitLogFn injectable.
export function buildDescription(
  head,
  base,
  gitLogFn = (_h, b) => tryRun('git', ['log', '--no-merges', '--pretty=format:- %s', `${b}..HEAD`]),
) {
  const log = gitLogFn(head, base)
  return log ? `${log}\n` : ''
}

// Classify the change type from the branch name and commit subjects, so the
// PR template's "Type of Change" boxes can be auto-ticked. Exported for tests.
export function classifyChange(head, commitsText) {
  const hay = `${head}\n${commitsText}`.toLowerCase()
  const flags = {
    bug: /\bfix\b|fix\//.test(hay),
    feature: /\bfeat\b|feature\//.test(hay),
    breaking: /break|breaking/.test(hay),
    docs: /\bdocs?\b|doc\//.test(hay),
  }
  // Guarantee at least one box is ticked (bug fix is the safe default).
  if (!flags.bug && !flags.feature && !flags.breaking && !flags.docs) flags.bug = true
  return flags
}

// Extract the first referenced issue number (e.g. "fix #123", "fixes #45") from
// the branch name and commit subjects. Exported for tests. Returns '' if none.
export function extractFixes(head, commitsText) {
  const hay = `${head}\n${commitsText}`
  const m = hay.match(/#(\d+)/)
  return m ? m[1] : ''
}

// Fill the auto-generated section of the PR template. Replaces the
// {{title}} / {{description}} / {{issue}} / {{tested}} / {{commits}} placeholders
// and ticks the relevant "Type of Change" boxes. Exported for tests.
export function fillTemplate(autoTemplate, ctx) {
  const { title, description, fixes, tested, typeFlags, commits } = ctx
  let out = autoTemplate
    .replace(/\{\{title\}\}/g, title || '')
    .replace(/\{\{description\}\}/g, description || '')
    .replace(/\{\{tested\}\}/g, tested || '')
    // {{issue}}: the issue number on its own line under the static
    // "Fixes #(issue number):" label. When none is referenced, "N/A" signals
    // "no associated issue" rather than leaving a blank line.
    .replace(/\{\{issue\}\}/g, fixes || 'N/A')
    .replace(/\{\{commits\}\}/g, commits || '')
  // Tick the matching Type of Change boxes.
  out = out
    .replace(/^- \[ \] (Bug fix.*)$/m, (_, c) => (typeFlags.bug ? `- [x] ${c}` : `- [ ] ${c}`))
    .replace(/^- \[ \] (New feature.*)$/m, (_, c) =>
      typeFlags.feature ? `- [x] ${c}` : `- [ ] ${c}`,
    )
    .replace(/^- \[ \] (Breaking change.*)$/m, (_, c) =>
      typeFlags.breaking ? `- [x] ${c}` : `- [ ] ${c}`,
    )
    .replace(/^- \[ \] (Documentation update.*)$/m, (_, c) =>
      typeFlags.docs ? `- [x] ${c}` : `- [ ] ${c}`,
    )
  return out
}

// Rebuild the whole PR body from the auto-generated section plus any manual
// content outside the AUTO_GENERATED markers. Deterministic (same inputs =>
// same output), so re-running is a no-op when nothing changed. Exported for
// unit testing.
//
// Three cases:
//   1. No existing body (first creation): use autoFilled verbatim — it already
//      carries both markers and the template's Checklist (now inside the markers).
//   2. Existing body is partitioned (has both markers): replace only the text
//      between START..END with autoFilled; preserve everything outside.
//   3. A2 — existing body is NOT partitioned (legacy PR with no markers):
//      insert the auto-generated section at the top and keep the entire
//      original body below it, so no human-written content is ever discarded.
//      The inserted section carries the markers, so the next refresh lands in
//      case 2 and stops stacking.
export function buildBody(autoFilled, existingBody) {
  if (!existingBody) return autoFilled
  const existingSection = extractAutoSection(existingBody)
  if (existingSection !== null) {
    // Case 2: precise in-place replacement of the auto section.
    const head = existingBody.slice(0, existingBody.indexOf(AUTO_GENERATED_START))
    const tail = existingBody.slice(
      existingBody.indexOf(AUTO_GENERATED_END) + AUTO_GENERATED_END.length,
    )
    return `${head}${autoFilled}${tail}`
  }
  // Case 3 (A2): legacy unpartitioned PR — prepend auto section, keep all.
  return `${autoFilled.trimEnd()}\n\n${existingBody.trim()}`
}

// Assemble the context object for fillTemplate from the branch and resolved
// base ref. The commit subjects drive the Description, type classification,
// and issue-number extraction. Exported for unit testing.
export function buildCtx(head, baseRef, title, commitsSection) {
  const commitsText = buildDescription(head, baseRef).replace(/^- /gm, '')
  return {
    title,
    description: commitsText,
    fixes: extractFixes(head, commitsText),
    tested: 'Covered by `npm test` and `npm run ci`; see the linked CI run for results.',
    typeFlags: classifyChange(head, commitsText),
    // commitsSection is always passed by callers; the `|| ''` is defensive.
    // v8 ignore next
    commits: commitsSection || '',
  }
}

// Build the full PR body for an existing PR: re-fill the template's auto
// section (between the START..END markers, Checklist included) and preserve
// any human-written content outside those markers. Exported for tests.
export function buildBodyFor(head, baseRef, existingBody) {
  let autoTemplate
  try {
    const tpl = readFileSync(TEMPLATE, 'utf8').trimEnd()
    const section = extractAutoSection(tpl)
    // The auto template is the text between the START..END markers (inclusive).
    // If the template is unpartitioned, fall back to the whole template.
    // The unpartitioned fallback (`: tpl`) only matters if the template loses
    // its markers; that cannot happen in practice, so ignore it for coverage.
    autoTemplate = section !== null ? section.replace(/\s+$/, '') : /* v8 ignore next */ tpl
  } catch {
    /* v8 ignore next */
    autoTemplate = ''
  }
  const autoFilled = fillTemplate(
    autoTemplate,
    buildCtx(head, baseRef, deriveTitle(head), buildCommitsSection(head, baseRef)),
  )
  return buildBody(autoFilled, existingBody)
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
// The whole function is excluded from coverage: it orchestrates external
// processes (`gh` / `git`) and calls `process.exit`, so it cannot be exercised
// by the pure-function unit tests. Its logic is delegated to the exported,
// fully-tested helpers above (resolveHead / buildBodyFor / buildCommitsSection
// / fillTemplate / buildBody), whose coverage is what we hold to 100%.
/* v8 ignore start */
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

  // Resolve the base ref to compare against. Prefer `origin/<base>` (fresh after
  // the fetch above, and present in CI even when the local `<base>` branch is
  // absent); fall back to the bare `<base>` only if the remote ref is missing.
  // Using the correct base ref is what makes `git log <base>..HEAD` return the
  // branch's commits instead of an empty range.
  const baseRef = tryRun('git', ['rev-parse', '--verify', `origin/${BASE}`])
    ? `origin/${BASE}`
    : BASE

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
    const newBody = buildBodyFor(head, baseRef, body)
    if (newBody === body) {
      console.log(`create-pr: PR already up to date for ${head} → ${BASE}: ${url}`)
      process.exit(0)
    }
    if (DRY_RUN) {
      console.log(
        `create-pr: [dry-run] would update PR #${number} (${url}) with body:\n` +
          '────────────────────────────────────────\n' +
          newBody +
          '\n────────────────────────────────────────',
      )
      process.exit(0)
    }
    try {
      run('gh', ['pr', 'edit', String(number), '--body', newBody])
    } catch (err) {
      const detail = (err && (err.stderr || err.stdout)) || err?.message || err
      fail(`failed to update the existing PR description (${url}):\n${detail}`)
    }
    console.log(`create-pr: updated PR description with latest commits: ${url}`)
    process.exit(0)
  }

  // This script only manages the PR — it never pushes. The head branch must
  // already exist on origin (push it yourself, or let the CI trigger do it).
  // Fail fast with a clear message if it is missing remotely.
  console.log(`create-pr: verifying '${head}' exists on origin...`)
  const remoteRef = tryRun('git', ['ls-remote', '--heads', 'origin', head])
  if (!remoteRef) {
    fail(
      `branch '${head}' is not found on origin. Push it first ` +
        `(e.g. \`git push -u origin ${head}\`), then re-run. This script does not push.`,
    )
  }

  const title = deriveTitle(head)
  const commitsSection = buildCommitsSection(head, baseRef)
  let autoFilled
  try {
    const tpl = readFileSync(TEMPLATE, 'utf8').trimEnd()
    const section = extractAutoSection(tpl)
    // The auto template is the text between the START..END markers (inclusive),
    // which now spans the whole template (Checklist included). If unpartitioned,
    // fall back to the whole template.
    const autoTemplate = section !== null ? section.replace(/\s+$/, '') : tpl
    autoFilled = fillTemplate(autoTemplate, buildCtx(head, baseRef, title, commitsSection))
  } catch {
    // Template missing/unreadable: fall back to just the commits list.
    autoFilled = commitsSection
  }
  const body = buildBody(autoFilled, '')

  if (DRY_RUN) {
    console.log(
      `create-pr: [dry-run] would create PR '${head}' → ${BASE} with title ` +
        `'${title || head}' and body:\n` +
        '────────────────────────────────────────\n' +
        body +
        '\n────────────────────────────────────────',
    )
    process.exit(0)
  }

  console.log(`create-pr: creating PR '${head}' → ${BASE} ...`)
  let out = null
  try {
    out = run('gh', [
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
  } catch (err) {
    // Surface the real `gh` error (it is on stderr) instead of swallowing it,
    // so the failure is diagnosable. A concurrent run may have just created the
    // PR; only treat as failure if no open PR for this head exists.
    const detail = (err && (err.stderr || err.stdout)) || err?.message || err
    console.error(`create-pr: gh pr create failed:\n${detail}`)
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
    fail('failed to create the PR. See the gh error above.')
  }
  console.log(`create-pr: created PR → ${out}`)
}
/* v8 ignore stop */

// Execute only when run as a script (e.g. `node scripts/create-pr.mjs` or via
// the `npm run pr` / CI workflow), not when imported by unit tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
// v8 ignore next: the direct-invocation guard only runs when executed as a
// script (not under vitest), so this branch cannot be exercised by unit tests.
if (invokedDirectly) {
  runMain()
}
