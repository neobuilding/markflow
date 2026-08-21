// GitHub Action entry point for "Create / Refresh PR".
//
// This is the ONLY module that knows about GitHub Actions (it reads inputs via
// `@actions/core` and calls `process.exit`). It assembles the real I/O services
// (TemplateSource / GitService / GhService), reads the template, loads the
// block-plugin registry, and delegates all the actual work to
// `createOrRefreshPr` in orchestration.mjs.
//
// Keeping this layer thin means the entire PR logic (render + orchestration) is
// unit-testable without `@actions/core`, without `gh`, without git, and without
// a token. See orchestration.test.mjs for the full-flow tests using fakes.
import * as core from '@actions/core'
import { join } from 'node:path'
import { createOrRefreshPr } from './orchestration.mjs'
import { buildBlockRegistry } from './loader.mjs'
import { createFsTemplateSource } from './services/template-source.mjs'
import { createExecGitService } from './services/git-service.mjs'
import { createExecGhService } from './services/gh-service.mjs'

async function main() {
  // Resolve the head branch: explicit input wins, else GitHub's refs.
  const head =
    core.getInput('head') || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || ''

  const base = core.getInput('base') || 'main'

  // `core.getInput` always returns a string; the default is 'false'. Compare
  // explicitly — bare truthiness on 'false' would be wrong.
  const dryRun = core.getInput('dry-run') === 'true'

  const templatePath = core.getInput('template') || '.github/pull-request-template.md'

  const blocksDir =
    core.getInput('blocks-dir') || join(process.cwd(), '.github', 'create-pr', 'blocks')

  const token = core.getInput('token', { required: true })

  if (!head) {
    core.setFailed(
      'Could not resolve a head branch (no `head` input and no GITHUB_HEAD_REF/REF_NAME).',
    )
    return
  }

  // Assemble the real I/O services. These are the only places that touch the
  // filesystem / git / gh. orchestration.mjs receives them as arguments.
  const templateSource = createFsTemplateSource()
  const git = createExecGitService()
  const gh = createExecGhService(token)

  // Read the template here (not inside orchestration) so orchestration stays
  // pure. If unreadable, pass null so orchestration falls back to a
  // commits-only body (same behavior as the old runMain).
  const template = (() => {
    try {
      return templateSource.read(templatePath)
    } catch {
      return null
    }
  })()

  // Build the block-plugin registry (built-in + user; user overrides built-in).
  const registry = await buildBlockRegistry(blocksDir)

  const result = await createOrRefreshPr({
    head,
    base,
    dryRun,
    template,
    registry,
    git,
    gh,
  })
  // On success, exit 0. createOrRefreshPr throws on hard failure (caught below).
  if (result.action === 'created' || result.action === 'updated') {
    // already logged inside orchestration
  }
  process.exit(0)
}

main().catch((err) => {
  core.setFailed(err?.message || String(err))
  process.exit(1)
})
