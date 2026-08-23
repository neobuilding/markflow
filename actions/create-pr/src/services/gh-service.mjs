// GhService: all `gh` (GitHub CLI) operations the PR action needs.
//
// This is the I/O boundary for "how do we create/edit/list PRs?". The default
// implementation spawns `gh` via `execFileSync` and injects the token into
// `process.env.GH_TOKEN`. The interface lets tests inject a fake GhService and
// assert on the exact `prCreate`/`prEdit` arguments without `gh` installed.
//
// Interface contract:
//   version(): string|null                  — `gh --version` (null if not installed)
//   prList(head, base): Array<{number,url,body}>  — open PRs for head→base
//   prCreate(head, base, title, body): string    — creates PR, returns URL
//   prEdit(number, body): void             — edits PR #number's body
//   prListUrls(head, base): string|null     — `gh pr list --jq .[0].url` (concurrency check)
import process from 'node:process'
import { execFileSync } from './exec-glue.mjs'

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim()
}

function tryRun(cmd, cmdArgs, opts = {}) {
  try {
    return run(cmd, cmdArgs, opts)
  } catch {
    return null
  }
}

// Default GhService backed by the real `gh` CLI. The token is injected into
// `process.env.GH_TOKEN` so that `gh` authenticates; the core logic never learns
// where the token came from.
export function createExecGhService(token) {
  if (token) process.env.GH_TOKEN = token

  return {
    version() {
      return tryRun('gh', ['--version'])
    },

    prList(head, base) {
      const out = tryRun('gh', [
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
      if (!out) return []
      try {
        return JSON.parse(out)
      } catch {
        return []
      }
    },

    prCreate(head, base, title, body) {
      return run('gh', [
        'pr',
        'create',
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body',
        body,
      ])
    },

    prEdit(number, body) {
      run('gh', ['pr', 'edit', String(number), '--body', body])
    },

    prListUrls(head, base) {
      return tryRun('gh', [
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
    },
  }
}
