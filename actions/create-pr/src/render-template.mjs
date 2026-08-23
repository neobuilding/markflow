// The single rendering entry point for the templating engine.
//
// This module renders a "block template" into a final string. The template
// language is generic — AUTO blocks delimited by `<!-- AUTO:key --> … {{key}}
// … <!-- /AUTO:key -->` with `{{placeholder}}` tokens — and is NOT specific to
// pull requests. It can drive PR bodies, changelogs, release notes, issue
// templates, etc. The only PR-specific knowledge here is the default base
// branch name; everything else is domain-agnostic.
//
// Both the GitHub Action plugin (index.mjs, via orchestration.mjs) and local
// previews / tests call THIS module. The caller supplies the already-read
// template string; this module owns everything else: assembling the git
// service, loading the block-plugin registry, building the render context, and
// running the pure renderer (fillAutoBlocks in render.mjs).
//
// The caller only says "render this template for this head/base" and gets back
// a string. No GitHub token, no `gh` CLI required — the `commits` block pulls
// commits itself from the injected git service (plugin-autonomy rule).
//
// Refresh: if `existingBody` is supplied, the freshly rendered body is merged
// into it via buildBody (refreshing each AUTO block in place, preserving human
// text outside the blocks). This is a pure, local operation — no `gh` needed —
// so a refresh preview can be produced entirely offline.
//
// Usage (local preview / test):
//   import { renderTemplate } from './render-template.mjs'
//   const body = await renderTemplate({ head: 'feature/my-branch', template })
//   console.log(body)
import { join } from 'node:path'
import { deriveTitle, buildCtx, fillAutoBlocks, buildBody } from './render.mjs'
import { createExecGitService } from './services/git-service.mjs'
import { buildBlockRegistry } from './loader.mjs'

const DEFAULT_BLOCKS_DIR = join(process.cwd(), '.github', 'create-pr', 'blocks')

// The minimal fallback template used when `template` is empty/unavailable:
// just a commits AUTO block so the `commits` plugin still renders.
// `{{commits}}` must live inside an AUTO block for fillAutoBlocks to render it.
const COMMITS_ONLY_TEMPLATE = '<!-- AUTO:commits -->\n{{commits}}\n<!-- /AUTO:commits -->'

// Resolve the base ref to compare against. Prefer `origin/<base>` (fresh after
// fetch, present in CI even when the local branch is absent); fall back to bare
// `<base>` only if the remote ref is missing (or there is no git service).
function resolveBaseRef(git, base) {
  if (!git) return base
  return git.revParse(`origin/${base}`) ? `origin/${base}` : base
}

// Render a template into a final body string.
//
// Options:
//   head          branch/subject name (required) — drives the title & commits
//   base          base branch to compare against (default 'main')
//   template      the ALREADY-READ template string (required); empty → commits-only
//   existingBody  optional existing body to refresh into (string); enables merge
//   blocksDir    directory of user block plugins (default '.github/create-pr/blocks')
//   noGit        omit the git service so the `commits` block renders empty
//
// Returns the rendered body string: the fresh render when `existingBody` is
// omitted, or the refresh-merged body when it is provided.
export async function renderTemplate({
  head,
  base = 'main',
  template = '',
  existingBody = null,
  blocksDir = DEFAULT_BLOCKS_DIR,
  noGit = false,
} = {}) {
  if (!head) {
    throw new Error('renderTemplate: `head` is required')
  }

  // Fall back to a commits-only template when no template content is supplied.
  const tpl = template && template.trim() ? template : COMMITS_ONLY_TEMPLATE

  // Assemble the services. Per the plugin-autonomy rule we only inject the git
  // service; the `commits` block pulls the commit list from ctx.services.git
  // itself. `--no-git` omits it entirely (commits renders empty).
  const services = {}
  if (!noGit) services.git = createExecGitService()

  // Build the block-plugin registry (built-in + user; user overrides built-in).
  // Loading plugins is part of rendering and only needed here.
  const registry = await buildBlockRegistry(blocksDir)

  // Resolve the base ref the commits plugin compares against.
  const baseRef = resolveBaseRef(services.git, base)

  const ctx = buildCtx(head, baseRef, deriveTitle(head), services)

  // The actual rendering is a single pure call. Both the Action and local
  // previews go through this exact line — rendering lives in one place.
  const fresh = fillAutoBlocks(tpl, ctx, registry)

  // Refresh: merge the fresh render into the existing body. When there is no
  // existing body, the fresh render is used verbatim (first creation).
  return existingBody != null ? buildBody(fresh, existingBody) : fresh
}
