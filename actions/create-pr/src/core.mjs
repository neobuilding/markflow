// Core logic for the "Create / Refresh PR" GitHub Action.
//
// This module is the SINGLE source of truth for PR automation. It is
// self-contained: it does NOT read Action inputs or receive the auth token.
// The Action entry point (`index.mjs`) injects the logical parameters
// (`head` / `base` / `dryRun` / `templatePath`) and sets `process.env.GH_TOKEN`
// before calling `runMain`. Keeping the core free of `@actions/core` side
// effects (beyond `setFailed`) makes it unit-testable and trivially
// extractable to its own repository.
//
// Behaviour:
//   - Opens (or refreshes) a PR via the GitHub CLI (`gh`), using the repo's PR
//     template (default `.github/pull-request-template.md`).
//   - Does NOT push. The head branch must already exist on origin; if it does
//     not, the script fails fast with a hint to push it first.
//   - Idempotent: if a PR for the head branch already exists, it is NOT
//     re-created; instead its description is refreshed to reflect the latest
//     commits on the branch. The PR body is split into independent auto blocks
//     marked with `<!-- AUTO:key --> ... <!-- /AUTO:key -->`. Each block is
//     refreshed from the template on every refresh (so the Checklist resets to
//     its template state and must be re-ticked after each push), while anything
//     a human writes OUTSIDE the blocks (the Description, any notes) is
//     preserved verbatim. Re-running on the same commits is a no-op.
//   - The block keys are NOT hard-coded: every `<!-- AUTO:x -->` marker found
//     in the template becomes an auto block, and any `{{name}}` placeholder
//     inside a block is rendered by a "block" plugin (a `(ctx) => string`
//     generator). Built-in blocks (`title` / `issue` / `commits`) ship with
//     the action; users may add their own `*.mjs` plugins (e.g. `types`) in
//     `.github/create-pr/blocks/`. Missing plugins leave `{{name}}` untouched.
//   - Derives the PR title from the branch name (feature/*, fix/*, etc.).
//
// Requirements:
//   - `gh` CLI installed and authenticated (GITHUB_TOKEN / GH_TOKEN in CI).
//   - Run inside a git worktree with a remote named `origin`.
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import * as core from '@actions/core'

// Each auto-generated *block* is wrapped in symmetric markers carrying a key,
// e.g. `<!-- AUTO:commits --> ... <!-- /AUTO:commits -->`. The script refreshes
// each block independently by key. The block keys are discovered dynamically
// from the template (see `discoverSegments`), so the action adapts to any repo's
// PR template instead of hard-coding a fixed set. Human-written content outside
// the blocks (the Description, any notes) can be freely interleaved and is
// preserved across refreshes.
//
// A block may contain `{{placeholder}}` tokens. Each placeholder is rendered by
// a "block plugin" — a `(ctx) => string` function looked up in the `blocks`
// registry (see `renderBlock`). Built-in plugins (`title` / `issue` /
// `commits`) ship with the action; users may register their own (e.g. `types`)
// via `.github/create-pr/blocks/`. A placeholder with no matching plugin is
// left untouched (the `{{name}}` text is preserved verbatim).
const AUTO_OPEN = '<!-- AUTO:'
const AUTO_CLOSE = '<!-- /AUTO:'

// Build (and parse) the symmetric markers for a given block key.
function openMarker(key) {
  return `${AUTO_OPEN}${key} -->`
}
function closeMarker(key) {
  return `${AUTO_CLOSE}${key} -->`
}
// Exported for unit testing.
export const markersFor = (key) => ({ open: openMarker(key), close: closeMarker(key) })

// Replace the content of a single auto block (between its open/close markers)
// with `content`. Returns the whole body unchanged when the block is absent so
// a missing block never drops human-written text. Exported for unit testing.
export function replaceAutoBlock(body, key, content) {
  const open = openMarker(key)
  const close = closeMarker(key)
  const start = body.indexOf(open)
  if (start === -1 || body.indexOf(close) === -1) return body
  const end = body.indexOf(close) + close.length
  return `${body.slice(0, start)}${open}\n${content}\n${close}${body.slice(end)}`
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

// Fail with a clear message. Uses core.setFailed (which marks the step failed
// and prints `::error::`) and then THROWS so the calling stack unwinds — unlike
// the original `process.exit(1)`, setFailed does not terminate the process, so
// the throw guarantees control flow stops. The entry point (`index.mjs`) wraps
// `runMain` in try/catch and re-declares via setFailed; internally we just rely
// on the throw to halt execution.
/* v8 ignore start */
function fail(msg) {
  const full = `create-pr: ${msg}`
  core.setFailed(full)
  throw new Error(full)
}
/* v8 ignore stop */

// Build the commit list (subjects with hashes) for commits on head that are
// not in base. The "## Commits" heading lives INSIDE the auto block in the
// template (above the {{commits}} placeholder), so this helper returns only the
// list body. Exported for unit testing. The git-log executor can be injected
// (gitLogFn) so tests run without
// a real repository; it defaults to the real `git log`.
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
  return `${log}\n`
}

// Build a human-readable commit summary (subjects only, no hashes). It drives
// the type classification and issue-number extraction in buildCtx. Exported for
// unit testing; gitLogFn injectable.
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

// Render a block plugin by name from the registry. Returns the rendered string
// when the plugin exists, otherwise the `{{name}}` placeholder text unchanged
// (so a missing plugin never drops or corrupts human content). Exported for
// unit testing. `blocks` maps a plugin name to its `(ctx) => string` generator.
export function renderBlock(name, ctx, blocks) {
  const fn = blocks && blocks[name]
  if (!fn) return `{{${name}}}`
  return fn(ctx)
}

// Discover every auto-block key present in a template by scanning its
// `<!-- AUTO:x --> ... <!-- /AUTO:x -->` markers. Keys are returned in document
// order, with duplicates de-duplicated (the first occurrence wins). A template
// with no markers yields an empty list — in that case nothing is rendered and
// the template is used verbatim as the PR body. Exported for unit testing.
export function discoverSegments(template) {
  const openRe = new RegExp(`${AUTO_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\w-]+) -->`, 'g')
  const keys = []
  let m
  while ((m = openRe.exec(template)) !== null) {
    const key = m[1]
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

// Fill every discovered auto block of the PR template from the context. The
// block keys are discovered dynamically (no hard-coded list). For each block,
// every `{{placeholder}}` token inside it is rendered by the matching plugin
// from `blocks`; tokens without a matching plugin are left untouched. Blocks
// with no `{{placeholder}}` (e.g. the Checklist) are copied verbatim, which
// resets them to the template state on every refresh. Exported for tests.
export function fillAutoBlocks(template, ctx, blocks = {}) {
  let out = template
  for (const key of discoverSegments(template)) {
    // The key is guaranteed present by discoverSegments, so slice its inner
    // content directly by the markers (no null branch to cover).
    const open = openMarker(key)
    const close = closeMarker(key)
    const start = template.indexOf(open) + open.length
    const end = template.indexOf(close)
    const blockText = template.slice(start, end).trim()
    // Render every `{{name}}` occurrence inside the block via its plugin.
    const rendered = blockText.replace(/\{\{(\w[\w-]*)\}\}/g, (whole, name) =>
      renderBlock(name, ctx, blocks),
    )
    out = replaceAutoBlock(out, key, rendered.trim())
  }
  return out
}

// Rebuild the whole PR body from the refreshed template plus any manual content
// the human has written. Because each auto block is refreshed independently by
// key, everything *outside* the blocks (the Description, any notes) is preserved
// verbatim. Deterministic (same inputs => same output), so re-running is a no-op
// when nothing changed. Exported for unit testing.
//
// Cases:
//   1. No existing body (first creation): use the freshly filled template
//      verbatim — it already carries every AUTO block.
//   2. Existing body already has the AUTO blocks: refresh each block in place
//      and keep all human content between/around them.
//   3. Legacy body with no AUTO blocks at all: prepend the filled template and
//      keep the entire original body below it, so no human-written content is
//      ever discarded. The inserted template carries the blocks, so the next
//      refresh lands in case 2 and stops stacking.
export function buildBody(filledTemplate, existingBody) {
  if (!existingBody) return filledTemplate
  // A body is "partitioned" (Case 2) when it carries at least one AUTO block.
  // We detect this dynamically rather than hard-coding a specific key: any
  // template may define its own block keys, and the renderer must adapt to all
  // of them. The first auto-block key found in the body is used as the probe.
  const bodyKeys = discoverSegments(existingBody)
  if (bodyKeys.length > 0) {
    // Case 2: refresh each block independently by copying fresh content in.
    // The set of keys to refresh is the union of the keys present in the
    // existing body and the keys present in the fresh template, so that a block
    // added to the template after the PR was created is still picked up, and a
    // block removed from the template leaves the (now stale) existing block
    // intact. No key is hard-coded.
    const refreshKeys = new Set([...bodyKeys, ...discoverSegments(filledTemplate)])
    let out = existingBody
    for (const key of refreshKeys) {
      const fresh = blockContent(filledTemplate, key)
      if (fresh !== null) out = replaceAutoBlock(out, key, fresh)
    }
    return out
  }
  // Case 3 (legacy): prepend filled template, keep all.
  return `${filledTemplate.trimEnd()}\n\n${existingBody.trim()}`
}

// Extract a block's inner content from a body, or null when the block is
// absent. Exported for unit testing.
export function blockContent(body, key) {
  const o = openMarker(key)
  const c = closeMarker(key)
  const s = body.indexOf(o)
  const e = body.indexOf(c)
  if (s === -1 || e === -1) return null
  return body.slice(s + o.length, e).trim()
}

// Assemble the context object for fillAutoBlocks from the branch and resolved
// base ref. The commit subjects drive the type classification and issue-number
// extraction. Exported for unit testing. The context exposes `head` and `base`
// (the resolved base ref) so block plugins can reference them, plus the derived
// fields (`title` / `fixes` / `typeFlags` / `commits`).
export function buildCtx(head, baseRef, title, commitsSection) {
  const commitsText = buildDescription(head, baseRef).replace(/^- /gm, '')
  return {
    head,
    base: baseRef,
    title,
    fixes: extractFixes(head, commitsText),
    typeFlags: classifyChange(head, commitsText),
    // commitsSection is always passed by callers; the `|| ''` is defensive.
    /* v8 ignore next */
    commits: commitsSection || '',
  }
}

// Build the full PR body for an existing PR: re-fill the template's auto blocks
// and preserve any human-written content outside those blocks. `blocks` is the
// registry of block plugins used to render `{{placeholder}}` tokens. Exported
// for tests.
export function buildBodyFor(
  head,
  baseRef,
  existingBody,
  templatePath = '.github/pull-request-template.md',
  blocks = {},
) {
  let filledTemplate
  try {
    const tpl = readFileSync(templatePath, 'utf8')
    filledTemplate = fillAutoBlocks(
      tpl,
      buildCtx(head, baseRef, deriveTitle(head), buildCommitsSection(head, baseRef)),
      blocks,
    )
  } catch {
    /* v8 ignore next */
    filledTemplate = ''
  }
  return buildBody(filledTemplate, existingBody)
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

// ── Main (only runs when invoked by the Action entry point) ──
// The whole function is excluded from coverage: it orchestrates external
// processes (`gh` / `git`) and calls `process.exit`, so it cannot be exercised
// by the pure-function unit tests. Its logic is delegated to the exported,
// fully-tested helpers above. A thrown `Error` from `fail()` bubbles up to the
// entry point (which reports it via `core.setFailed`); we do NOT swallow it here.
/* v8 ignore start */
export async function runMain({
  head,
  base = 'main',
  dryRun = false,
  templatePath = '.github/pull-request-template.md',
  blocks = {},
}) {
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
  const fetched = tryRun('git', ['fetch', 'origin', base, '--quiet'])
  if (fetched === null) {
    console.warn(
      `create-pr: warning: could not fetch '${base}' from origin; ` +
        'the commit list may be based on a stale local ref.',
    )
  }

  // Resolve the base ref to compare against. Prefer `origin/<base>` (fresh after
  // the fetch above, and present in CI even when the local `<base>` branch is
  // absent); fall back to the bare `<base>` only if the remote ref is missing.
  // Using the correct base ref is what makes `git log <base>..HEAD` return the
  // branch's commits instead of an empty range.
  const baseRef = tryRun('git', ['rev-parse', '--verify', `origin/${base}`])
    ? `origin/${base}`
    : base

  // Idempotency: find an existing open PR for this head -> base.
  const existing = tryRun('gh', [
    'pr',
    'list',
    '--head',
    head,
    '--base',
    base,
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
    const newBody = buildBodyFor(head, baseRef, body, templatePath)
    if (newBody === body) {
      console.log(`create-pr: PR already up to date for ${head} → ${base}: ${url}`)
      process.exit(0)
    }
    if (dryRun) {
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
  let filledTemplate
  try {
    const tpl = readFileSync(templatePath, 'utf8')
    filledTemplate = fillAutoBlocks(tpl, buildCtx(head, baseRef, title, commitsSection), blocks)
  } catch {
    // Template missing/unreadable: fall back to just the commits list.
    filledTemplate = commitsSection
  }
  const body = buildBody(filledTemplate, '')

  if (dryRun) {
    console.log(
      `create-pr: [dry-run] would create PR '${head}' → ${base} with title ` +
        `'${title || head}' and body:\n` +
        '────────────────────────────────────────\n' +
        body +
        '\n────────────────────────────────────────',
    )
    process.exit(0)
  }

  console.log(`create-pr: creating PR '${head}' → ${base} ...`)
  let out = null
  try {
    out = run('gh', [
      'pr',
      'create',
      '--base',
      base,
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
      base,
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

// The Action entry point (index.mjs) imports and calls runMain directly, so no
// direct-invocation guard is needed here. The previous CLI guard
// (`import.meta.url === pathToFileURL(process.argv[1]).href`) is intentionally
// dropped: this module is no longer a standalone script, only an importable
// library + the runMain export used by index.mjs.
