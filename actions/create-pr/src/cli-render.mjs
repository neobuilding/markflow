#!/usr/bin/env node
// Local PR-template rendering CLI.
//
// Renders the full PR body from a template + block plugins. This is the "I just
// want to see what the PR body looks like" entry point. It needs NO GitHub
// token and NO `gh` CLI.
//
// Following the plugin-autonomy rule, this CLI does NOT worry about which plugin
// needs which data. It only assembles the I/O services, injects them into the
// render context via buildCtx, and lets each block plugin pull what it needs
// from `ctx.services` (e.g. the `commits` plugin calls
// `ctx.services.git.logRange(...)` itself). Adding a new plugin never requires
// touching this file.
//
// Usage:
//   node actions/create-pr/src/cli-render.mjs \
//     --head feature/my-branch \
//     [--base main] \
//     [--template .github/pull-request-template.md] \
//     [--blocks-dir .github/create-pr/blocks] \
//     [--no-git]
//
// By default a GitService is provided via ctx.services.git, so the `commits`
// block renders the real `git log <base>..HEAD`. Pass `--no-git` to run without
// any git service (the `commits` plugin then renders empty) — handy on machines
// without git or to inspect just the template structure.
//
// Exit codes: 0 on success, 1 on error (missing --head, template unreadable).
import { join } from 'node:path'
import { deriveTitle, buildCtx, fillAutoBlocks } from './render.mjs'
import { createExecGitService } from './services/git-service.mjs'
import { createFsTemplateSource } from './services/template-source.mjs'
import { buildBlockRegistry } from './loader.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--head') args.head = next
    else if (arg === '--base') args.base = next
    else if (arg === '--template') args.template = next
    else if (arg === '--blocks-dir') args.blocksDir = next
    else if (arg === '--no-git') args.noGit = true
  }
  return args
}

function main() {
  const args = parseArgs(process.argv)
  if (!args.head) {
    console.error('create-pr: --head is required (e.g. --head feature/my-branch)')
    process.exit(1)
  }

  const head = args.head
  const base = args.base || 'main'
  const templatePath = args.template || '.github/pull-request-template.md'
  const blocksDir = args.blocksDir || '.github/create-pr/blocks'

  // Read the template (this CLI's own file I/O).
  let template
  try {
    template = createFsTemplateSource().read(templatePath)
  } catch {
    console.error(`create-pr: could not read template at '${templatePath}'`)
    process.exit(1)
  }

  // Assemble the services and hand them to the render context. We do NOT pre-
  // fetch commits here — the `commits` plugin pulls them from ctx.services.git
  // itself. `--no-git` omits the git service entirely.
  const services = {}
  if (!args.noGit) services.git = createExecGitService()

  const ctx = buildCtx(head, base, deriveTitle(head), services)

  // Load the registry (built-in blocks + user blocks, like the real action).
  buildBlockRegistry(join(process.cwd(), blocksDir)).then((registry) => {
    const body = fillAutoBlocks(template, ctx, registry)
    console.log(body)
  })
}

main()
