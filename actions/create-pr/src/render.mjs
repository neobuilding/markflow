// Pure rendering logic for the "Create / Refresh PR" GitHub Action.
//
// This module is the SINGLE source of truth for PR body rendering. It is
// 100% pure: zero file IO, zero `@actions/core`, zero `execFileSync`, zero
// `process.env`. Every function is deterministic and trivially unit-testable.
//
// The "Which block keys exist?" and "What does each {{placeholder}} render to?"
// decisions live here. The "How to read the template / how to run git / how to
// call gh" decisions live in the service modules (services/*.mjs) and the
// orchestration module (orchestration.mjs). This separation is what lets you
// render a full PR body locally without any GH_TOKEN, `gh`, or git history.

// Each auto-generated *block* is wrapped in symmetric markers carrying a key,
// e.g. `<!-- AUTO:commits --> ... <!-- /AUTO:commits -->`. The block keys are
// discovered dynamically from the template (see `discoverSegments`), so the
// action adapts to any repo's PR template instead of hard-coding a fixed set.
// Human-written content outside the blocks can be freely interleaved and is
// preserved across refreshes.
//
// A block may contain `{{placeholder}}` tokens. Each placeholder is rendered by
// a "block plugin" — a `(ctx) => string` function looked up in the `blocks`
// registry (see `renderBlock`). Built-in plugins (`title` / `issue` / `commits`)
// ship with the action; users may register their own (e.g. `types`) via
// `.github/create-pr/blocks/`. A placeholder with no matching plugin is left
// untouched (the `{{name}}` text is preserved verbatim).
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

// Build the commit list (subjects with hashes) for commits on head that are
// not in base. The "## Commits" heading lives INSIDE the auto block in the
// template (above the {{commits}} placeholder), so this helper returns only the
// list body. Exported for unit testing. The git-log executor can be injected
// (gitLogFn) so tests run without a real repository; when no gitLogFn is given
// it returns '' (this module never spawns git — the caller provides commits).
export function buildCommitsSection(head, base, gitLogFn) {
  if (!gitLogFn) return ''
  const log = gitLogFn(head, base)
  if (!log) return ''
  return `${log}\n`
}

// Build a human-readable commit summary (subjects only, no hashes). It drives
// the type classification and issue-number extraction in buildCtx. Exported for
// unit testing; gitLogFn injectable.
export function buildDescription(head, base, gitLogFn) {
  if (!gitLogFn) return ''
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
    const open = openMarker(key)
    const close = closeMarker(key)
    const start = template.indexOf(open) + open.length
    const end = template.indexOf(close)
    const blockText = template.slice(start, end).trim()
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
  const bodyKeys = discoverSegments(existingBody)
  if (bodyKeys.length > 0) {
    const refreshKeys = new Set([...bodyKeys, ...discoverSegments(filledTemplate)])
    let out = existingBody
    for (const key of refreshKeys) {
      const fresh = blockContent(filledTemplate, key)
      if (fresh !== null) out = replaceAutoBlock(out, key, fresh)
    }
    return out
  }
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

// Assemble the context object for fillAutoBlocks from the branch, resolved base
// ref, title, and the injected services.
//
// The `services` object carries the I/O capabilities each block plugin may call
// on its own (per the plugin-autonomy design): `services.git`, `services.gh`,
// `services.templateSource`. The context exposes `head` / `base` (resolved base
// ref) / `title` plus two *shared derived facts* the plugins commonly consume:
// `fixes` (linked issue number) and `typeFlags` (Bug/feature/breaking/docs).
// These two are derived once here — from `services.git.logSubjects` — so the
// `issue` and `types` plugins don't each re-run git. Individual plugins may
// still call `ctx.services.git` themselves for data only they need (e.g. the
// `commits` plugin fetches the commit list itself). This keeps the renderer and
// orchestrator free of "which data does each plugin need" — a new plugin can
// pull whatever it wants from `ctx.services`.
export function buildCtx(head, baseRef, title, services) {
  const git = services && services.git
  const commitsText = buildDescription(
    head,
    baseRef,
    git && ((h, b) => git.logSubjects(h, b)),
  ).replace(/^- /gm, '')
  return {
    head,
    base: baseRef,
    title,
    services: services || {},
    fixes: extractFixes(head, commitsText),
    typeFlags: classifyChange(head, commitsText),
  }
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
