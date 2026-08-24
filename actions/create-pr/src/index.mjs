// GitHub Action entry point for "Create / Refresh PR".
//
// This is the ONLY module that knows about GitHub Actions (it reads inputs via
// `@actions/core` and calls `process.exit`). It assembles the real I/O services
// (GitService / GhService), reads the template FILE into a string, and delegates
// the actual work to `createOrRefreshPr` in orchestration.mjs. Rendering itself
// lives in render-template.mjs and is invoked by orchestration.
//
// Keeping this layer thin means the entire PR logic (render + orchestration) is
// unit-testable without `@actions/core`, without `gh`, without git, and without
// a token. See orchestration.test.mjs for the full-flow tests using fakes.
import * as core from '@actions/core'
import { join } from 'node:path'
import { createOrRefreshPr } from './orchestration.mjs'
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

  // Real I/O services. These are the only places that touch git / gh.
  const git = createExecGitService()
  const gh = createExecGhService(token)

  // Read the template FILE into a string. The caller owns file I/O; the
  // renderer takes the string. If unreadable, pass '' so the renderer falls
  // back to a commits-only body.
  const templateSource = createFsTemplateSource()
  let template
  try {
    template = templateSource.read(templatePath)
  } catch {
    template = ''
  }

  // createOrRefreshPr throws on hard failure (caught below); on success we just
  // exit 0 (the action result was already logged inside orchestration).
  await createOrRefreshPr({
    head,
    base,
    dryRun,
    template,
    blocksDir,
    git,
    gh,
  })
  process.exit(0)
}

main().catch((err) => {
  core.setFailed(err?.message || String(err))
  process.exit(1)
})
