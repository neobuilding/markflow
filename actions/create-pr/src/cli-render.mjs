#!/usr/bin/env node
// Local template-rendering CLI.
//
// Renders a block template into a final string and prints it. This is the "I
// just want to see what the rendered body looks like" entry point. It needs NO
// GitHub token and NO `gh` CLI.
//
// It is a thin wrapper over the single rendering entry point
// (render-template.mjs): it only reads files (template + optional existing
// body) and prints the result. All rendering logic lives in render-template.mjs,
// shared with the GitHub Action plugin (index.mjs, via orchestration.mjs).
//
// Usage:
//   node actions/create-pr/src/cli-render.mjs \
//     --head feature/my-branch \
//     [--base main] \
//     [--template .github/pull-request-template.md] \   # defaults to this path
//     [--existing /path/to/current-pr-body.md] \   # preview a REFRESH (merge)
//     [--blocks-dir .github/create-pr/blocks] \
//     [--no-git]
//
// When --template is omitted, the same default path the Action uses
// (.github/pull-request-template.md) is read, so a bare --head previews the
// real PR template. When the template file is missing, it falls back to a
// commits-only body (matching index.mjs).
//
// By default a GitService is provided so the `commits` block renders the real
// `git log <base>..HEAD`. Pass `--no-git` to run without any git service (the
// `commits` plugin then renders empty) — handy on machines without git or to
// inspect just the template structure.
//
// Exit codes: 0 on success, 1 on error (missing --head, or unreadable file).
import { join } from 'node:path'
import { renderTemplate } from './render-template.mjs'
import { createFsTemplateSource } from './services/template-source.mjs'

// Same default template path the GitHub Action uses in index.mjs. Mirroring it
// here means a bare `cli-render.mjs --head x` previews the real PR template with
// no extra flags.
const DEFAULT_TEMPLATE_PATH = join(process.cwd(), '.github', 'pull-request-template.md')

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--head') args.head = next
    else if (arg === '--base') args.base = next
    else if (arg === '--template') args.template = next
    else if (arg === '--existing') args.existing = next
    else if (arg === '--blocks-dir') args.blocksDir = next
    else if (arg === '--no-git') args.noGit = true
  }
  return args
}

// Read a template/existing-body file into a string. The caller owns file I/O
// and hands the string to the renderer. If unreadable, return '' so the
// renderer falls back to a commits-only body (matching index.mjs behavior).
function readTemplateOrEmpty(path) {
  if (!path) return ''
  try {
    return createFsTemplateSource().read(path)
  } catch {
    return ''
  }
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.head) {
    console.error('create-pr: --head is required (e.g. --head feature/my-branch)')
    process.exit(1)
  }

  // The caller owns file I/O: read the template (defaulting to the same path
  // the Action uses) and the optional existing body into strings, then hand
  // them to the renderer.
  const template = readTemplateOrEmpty(args.template || DEFAULT_TEMPLATE_PATH)
  const existingBody = args.existing ? readTemplateOrEmpty(args.existing) : null

  const body = await renderTemplate({
    head: args.head,
    base: args.base,
    template,
    existingBody,
    blocksDir: args.blocksDir,
    noGit: args.noGit,
  })
  console.log(body)
}

main().catch((err) => {
  console.error(`create-pr: ${err?.message || String(err)}`)
  process.exit(1)
})
