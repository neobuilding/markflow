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
// a "block plugin" a `(ctx) => string` function looked up in the `blocks`
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
// it returns '' (this module never spawns git the caller provides commits)
export function buildCommitsSection(head, base, gitLogFn) {
  if (!gitLogFn) return ''
  const log = gitLogFn(head, base)
  if (!log) return ''
  return `${log}\n`
}

// Build a human-readable commit summary (subjects only, no hashes). Exported for
// unit testing; gitLogFn injectable. NOTE: this helper is no longer consumed by
// the render core the `types` / `issue` plugins now fetch raw commit data from
// `ctx.services.git` themselves (plugin-autonomy). It remains as a tested pure
// utility.
export function buildDescription(head, base, gitLogFn) {
  if (!gitLogFn) return ''
  const log = gitLogFn(head, base)
  return log ? `${log}\n` : ''
}

// Classification & issue extraction live INSIDE the plugins themselves (the
// repo-side `types` plugin inlines `classifyChange`; the built-in `issue` plugin
// inlines `extractFixes`). There is deliberately no core classification module.
// The render core (this module) knows nothing about "PR type" or "linked issue"
// it only assembles `ctx` (inputs + injectable `services`) and lets each plugin
// pull the data it needs. See `docs/adr/0022-*.md`.

// Render a block plugin by name from the registry. Returns the rendered string
// when the plugin exists, otherwise the `{{name}}` placeholder text unchanged
// (so a missing plugin never drops or corrupts human content). Exported for
// unit testing. `blocks` maps a plugin name to its `(ctx) => string | Promise<string>`
// generator (plugins may be async, e.g. when they await `ctx.services.git`).
export async function renderBlock(name, ctx, blocks) {
  const fn = blocks && blocks[name]
  if (!fn) return `{{${name}}}`
  try {
    // A plugin may be async (it often awaits `ctx.services.git`); resolve it.
    return await fn(ctx)
  } catch {
    // A throwing plugin must not abort the whole render (resilience): leave the
    // placeholder untouched, exactly as if the plugin were missing.
    return `{{${name}}}`
  }
}

// Discover every auto-block key present in a template by scanning its
// `<!-- AUTO:x --> ... <!-- /AUTO:x -->` markers. Keys are returned in document
// order, with duplicates de-duplicated (the first occurrence wins). A template
// with no markers yields an empty list in that case nothing is rendered and
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
export async function fillAutoBlocks(template, ctx, blocks = {}) {
  let out = template
  for (const key of discoverSegments(template)) {
    const open = openMarker(key)
    const close = closeMarker(key)
    const start = template.indexOf(open) + open.length
    const end = template.indexOf(close)
    const blockText = template.slice(start, end).trim()
    // Each `{{token}}` is rendered by its plugin; plugins may be async, so collect
    // the promises in parallel and substitute all occurrences of each token.
    const rendered = await Promise.all(
      [...blockText.matchAll(/\{\{(\w[\w-]*)\}\}/g)].map(async (m) => {
        const value = await renderBlock(m[1], ctx, blocks)
        return [m[0], value]
      }),
    ).then((pairs) =>
      pairs.reduce((acc, [token, value]) => acc.split(token).join(value), blockText),
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
// verbatim it already carries every AUTO block
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

// Assemble the context object for fillAutoBlocks from the branch, the resolved
// base ref, the derived title, and the injected I/O `services`.
//
// Per the plugin-autonomy contract, the core NEVER pre-computes domain facts such
// as the PR "type" or the linked "issue number". Those are derived by the `types`
// / `issue` plugins themselves, each pulling raw data from `ctx.services.git`
// (the git service is memoized at the injection boundary in render-template.mjs,
// so multiple plugins calling it cost at most one real git spawn per method).
// The renderer/orchestrator therefore stays ignorant of "which data each plugin
// needs": a new plugin simply pulls whatever it wants from `ctx.services`
// (and `head` / `base` / `title`).
//
// @typedef {Object} PluginContext
// @property {string} head      resolved head branch name
// @property {string} base      resolved base ref (e.g. `origin/main`)
// @property {string} title     derived PR title
// @property {Object} services  injectable I/O capabilities (git / gh / templateSource)
//
// @typedef {function(PluginContext): (string|Promise<string>)} BlockPlugin
export function buildCtx(head, baseRef, title, services) {
  return {
    head,
    base: baseRef,
    title,
    services: services || {},
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
