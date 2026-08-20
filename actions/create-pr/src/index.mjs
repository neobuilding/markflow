// GitHub Action entry point for "Create / Refresh PR".
//
// Reads the Action inputs, injects the GH token into `process.env.GH_TOKEN`
// (so that `core.mjs`'s `gh` calls authenticate), and delegates all the real
// work to `runMain` in core.mjs. This layer is intentionally thin and holds no
// PR logic of its own.
import * as core from '@actions/core'
import { runMain } from './core.mjs'

async function main() {
  // Resolve the head branch: an explicit `head` input wins, otherwise fall back
  // to GitHub-provided refs (PR event => GITHUB_HEAD_REF, push event =>
  // GITHUB_REF_NAME). This makes the action self-deciding in any repo / event.
  const head =
    core.getInput('head') || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || ''

  const base = core.getInput('base') || 'main'

  // `core.getInput` always returns a string; the input's default is the string
  // 'false'. We must compare explicitly — a bare truthiness check on the string
  // 'false' would wrongly be truthy.
  const dryRun = core.getInput('dry-run') === 'true'

  const templatePath = core.getInput('template') || '.github/pull-request-template.md'

  // Authenticate `gh` with the supplied PAT (the default GITHUB_TOKEN cannot
  // create PRs). core.mjs reads GH_TOKEN from the environment; it never learns
  // the token's source.
  const token = core.getInput('token', { required: true })
  process.env.GH_TOKEN = token

  if (!head) {
    core.setFailed(
      'Could not resolve a head branch (no `head` input and no GITHUB_HEAD_REF/REF_NAME).',
    )
    return
  }

  // runMain throws on failure (from core.fail), so wrap it here and report via
  // setFailed. Do NOT swallow the error — setFailed alone does not stop the step.
  await runMain({ head, base, dryRun, templatePath })
}

main().catch((err) => {
  core.setFailed(err?.message || String(err))
})
