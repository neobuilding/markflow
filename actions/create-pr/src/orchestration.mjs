// Orchestration: the create-or-refresh-PR decision flow, decoupled from I/O.
//
// This module is the equivalent of the old `runMain` in core.mjs, but with every
// external interaction behind an injectable service:
//   - TemplateSource  (read the PR template)
//   - GitService      (fetch, rev-parse, log, ls-remote, remote check)
//   - GhService       (gh version, pr list/create/edit)
//
// The function returns a result object describing what happened (or throws on
// hard failures). It NEVER calls `process.exit` — that is the entry point's
// job. It NEVER reads env vars or Action inputs. This makes the whole flow
// unit-testable with fake services.
//
// Behaviour (unchanged from the old runMain, only the boundaries moved):
//   - Opens (or refreshes) a PR via the GhService, using the repo's PR template.
//   - Does NOT push. The head branch must already exist on origin.
//   - Idempotent: existing PR is refreshed, not re-created. No-op if unchanged.
//   - Splits the PR body into independent auto blocks (see render.mjs).
//   - Derives the PR title from the branch name.
import { deriveTitle, buildCtx, fillAutoBlocks, buildBody } from './render.mjs'

function fail(msg) {
  throw new Error(`create-pr: ${msg}`)
}

// Resolve the base ref to compare against. Prefer `origin/<base>` (fresh after
// fetch, present in CI even when the local branch is absent); fall back to bare
// `<base>` only if the remote ref is missing.
function resolveBaseRef(git, base) {
  return git.revParse(`origin/${base}`) ? `origin/${base}` : base
}

// Create or refresh a PR. Returns one of:
//   { action: 'noop',     url }                  — existing PR already up to date
//   { action: 'updated', url }                  — existing PR body refreshed
//   { action: 'would-update', number, url, body } — dryRun, existing PR would be updated
//   { action: 'created',  url }                  — new PR created
//   { action: 'would-create', title, body }      — dryRun, new PR would be created
//   { action: 'concurrent', url }                — a concurrent run created the PR
//
// Throws on hard failures (gh missing, no origin, branch not on origin, gh
// command failed with no concurrent PR).
//
// `blocks` is the block-plugin registry (built by loader.buildBlockRegistry).
// `template` is the already-read template string (read by the caller via
// TemplateSource). Passing the string (not the path) keeps this function pure
// and lets the caller decide the I/O strategy.
export async function createOrRefreshPr({
  head,
  base = 'main',
  dryRun = false,
  template, // string (already read), or null/undefined to skip template rendering
  registry = {},
  git,
  gh,
  log = console.log, // injectable for tests
  warn = console.warn,
}) {
  if (!git) fail('git service is required')
  if (!gh) fail('gh service is required')

  // Check `gh` is installed.
  if (!gh.version()) {
    fail("GitHub CLI ('gh') is not installed or not on PATH. Install: https://cli.github.com/")
  }

  // Check origin remote exists.
  if (!git.hasOrigin()) {
    fail("no 'origin' remote configured. Add one with: git remote add origin <url>")
  }

  // Fetch base so the commit diff is accurate (local CI checkout may be
  // shallow). Non-fatal: warn but continue with whatever local base we have.
  if (git.fetchBase(base) === null) {
    warn(
      `create-pr: warning: could not fetch '${base}' from origin; ` +
        'the commit list may be based on a stale local ref.',
    )
  }

  const baseRef = resolveBaseRef(git, base)
  const title = deriveTitle(head)

  // Assemble the render context. Per the plugin-autonomy rule, we only inject
  // the services — the `commits` block pulls the commit list itself from
  // ctx.services.git, and buildCtx derives the shared fixes/typeFlags from
  // git.logSubjects. We do NOT pre-fetch commits here.
  const ctx = buildCtx(head, baseRef, title, { git, gh })

  // Render the template into a filled body. If the template is missing/empty,
  // fall back to a minimal AUTO block so the commits plugin still fills the
  // commit list from git (same intent as the old runMain's commits-only
  // fallback, but without the renderer knowing how to fetch them — the plugin
  // pulls the data itself). `{{commits}}` must live inside an AUTO block for
  // fillAutoBlocks to render it.
  const renderTemplate = template || '<!-- AUTO:commits -->\n{{commits}}\n<!-- /AUTO:commits -->'
  const filledTemplate = fillAutoBlocks(renderTemplate, ctx, registry)
  const freshBody = buildBody(filledTemplate, '')

  // Idempotency: find an existing open PR for this head -> base.
  const existingPrs = gh.prList(head, base)

  if (existingPrs.length > 0) {
    const { number, url, body = '' } = existingPrs[0]
    const newBody = buildBody(filledTemplate, body)
    if (newBody === body) {
      log(`create-pr: PR already up to date for ${head} → ${base}: ${url}`)
      return { action: 'noop', url }
    }
    if (dryRun) {
      log(
        `create-pr: [dry-run] would update PR #${number} (${url}) with body:\n` +
          '────────────────────────────────────────\n' +
          newBody +
          '\n────────────────────────────────────────',
      )
      return { action: 'would-update', number, url, body: newBody }
    }
    try {
      gh.prEdit(number, newBody)
    } catch (err) {
      const detail = (err && (err.stderr || err.stdout)) || err?.message || err
      fail(`failed to update the existing PR description (${url}):\n${detail}`)
    }
    log(`create-pr: updated PR description with latest commits: ${url}`)
    return { action: 'updated', url }
  }

  // This script only manages the PR — it never pushes. The head branch must
  // already exist on origin. Fail fast if it is missing remotely.
  log(`create-pr: verifying '${head}' exists on origin...`)
  if (!git.lsRemote(head)) {
    fail(
      `branch '${head}' is not found on origin. Push it first ` +
        `(e.g. \`git push -u origin ${head}\`), then re-run. This script does not push.`,
    )
  }

  if (dryRun) {
    log(
      `create-pr: [dry-run] would create PR '${head}' → ${base} with title ` +
        `'${title || head}' and body:\n` +
        '────────────────────────────────────────\n' +
        freshBody +
        '\n────────────────────────────────────────',
    )
    return { action: 'would-create', title: title || head, body: freshBody }
  }

  log(`create-pr: creating PR '${head}' → ${base} ...`)
  let out
  try {
    out = gh.prCreate(head, base, title || head, freshBody)
  } catch (err) {
    // Surface the real `gh` error. A concurrent run may have just created the
    // PR; only treat as failure if no open PR for this head exists.
    const detail = (err && (err.stderr || err.stdout)) || err?.message || err
    log(`create-pr: gh pr create failed:\n${detail}`)
    const concurrent = gh.prListUrls(head, base)
    if (concurrent) {
      log(`create-pr: PR created concurrently: ${concurrent}`)
      return { action: 'concurrent', url: concurrent }
    }
    fail('failed to create the PR. See the gh error above.')
  }
  log(`create-pr: created PR → ${out}`)
  return { action: 'created', url: out }
}
