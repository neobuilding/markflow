// Orchestration: the create-or-refresh-PR decision flow, decoupled from I/O.
//
// Every external interaction is behind an injectable service:
//   - GitService      (fetch, rev-parse, log, ls-remote, remote check)
//   - GhService       (gh version, pr list/create/edit)
//
// The function returns a result object describing what happened (or throws on
// hard failures). It NEVER calls `process.exit` — that is the entry point's
// job. It NEVER reads env vars or Action inputs. This makes the whole flow
// unit-testable with fake services.
//
// Behaviour:
//   - Opens (or refreshes) a PR via the GhService, using the repo's PR template.
//   - Does NOT push. The head branch must already exist on origin.
//   - Idempotent: existing PR is refreshed, not re-created. No-op if unchanged.
//   - Splits the PR body into independent auto blocks (see render.mjs).
//   - Derives the PR title from the branch name.
//   - Delegates rendering to render-template.mjs (one render step in the flow);
//     it does NOT implement rendering itself — rendering lives in exactly one
//     module.
import { deriveTitle } from './render.mjs'
import { renderTemplate as renderTemplateImpl } from './render-template.mjs'

function fail(msg) {
  throw new Error(`create-pr: ${msg}`)
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
// Rendering is one of the orchestrated steps: after we learn the existing PR
// body (if any) from `gh.prList`, we delegate to `renderTemplate` to produce the
// final body — a fresh render for a new PR, or the refresh-merged body for an
// existing one. This keeps all rendering in exactly one module while leaving
// the create/refresh *decision* (noop / updated / created / concurrent) here.
export async function createOrRefreshPr({
  head,
  base = 'main',
  dryRun = false,
  template = '', // already-read template string (caller reads the file)
  blocksDir, // optional override for block-plugin directory
  git,
  gh,
  renderTemplate = renderTemplateImpl, // injectable; defaults to the real renderer
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

  const title = deriveTitle(head)

  // Idempotency: find an existing open PR for this head -> base. Its current
  // body (if any) is fed back into the renderer so the refresh merges the fresh
  // AUTO blocks into it, preserving human text outside the blocks.
  const existingPrs = gh.prList(head, base)
  const existingBody = existingPrs.length > 0 ? (existingPrs[0].body ?? '') : null

  // Rendering step (delegated to the single rendering module): produces the
  // final body — fresh for a new PR, refresh-merged for an existing one.
  const body = await renderTemplate({
    head,
    base,
    template,
    existingBody,
    blocksDir,
  })

  if (existingPrs.length > 0) {
    const { number, url } = existingPrs[0]
    const newBody = body
    if (newBody === existingBody) {
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
        body +
        '\n────────────────────────────────────────',
    )
    return { action: 'would-create', title: title || head, body }
  }

  log(`create-pr: creating PR '${head}' → ${base} ...`)
  let out
  try {
    out = gh.prCreate(head, base, title || head, body)
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
