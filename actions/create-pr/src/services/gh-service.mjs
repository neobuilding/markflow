// GhService: all `gh` (GitHub CLI) operations the PR action needs.
//
// This is the I/O boundary for "how do we create/edit/list PRs?". The default
// implementation spawns `gh` via `execFileSync` and injects the token into
// `process.env.GH_TOKEN`. The interface lets tests inject a fake GhService and
// assert on the exact `prCreate`/`prEdit` arguments without `gh` installed.
//
// Interface contract:
// version: string|null `gh --version` (null if not installed)
// prList(head, base): Array<{number,url,body}> open PRs for head→base
// prCreate(head, base, title, body): string creates PR, returns URL
// prEdit(number, body): void edits PR #number's body
// prListUrls(head, base): string|null `gh pr list --jq .[0].url` (concurrency check)
import process from 'node:process'
import { execFileSync } from './exec-glue.mjs'

// `gh` talks to the GitHub API over HTTP/2. On GitHub-hosted runners a transient
// connection drop surfaces as a bare `EOF` (Go's io.EOF) when the CLI reads a
// response that was closed mid-stream. A single such failure used to abort the
// whole workflow, so we retry retryable failures a few times with a short
// synchronous backoff before giving up. Non-retryable errors (auth, validation,
// missing branch) still fail fast on the first attempt.
const MAX_GH_ATTEMPTS = 3
const GH_RETRY_BASE_DELAY_MS = 250
const TRANSIENT_ERROR_RE =
  /EOF|timed?\s?out|timeout|502|503|504|rate[ _-]?limit|service unavailable|bad gateway|internal server error|connection reset|broken pipe|socket hang up|network is unreachable|temporary failure|failed to connect/i

function isTransient(err) {
  // execFileSync embeds the child's stderr into err.message (e.g.
  // "Command failed: gh pr edit ...\nEOF"), so message alone is enough to
  // classify the failure.
  return TRANSIENT_ERROR_RE.test(String(err.message))
}

function sleepSync(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // brief synchronous pause between retries; fine for a one-shot CLI action
  }
}

// execFileSync's error message is "Command failed: gh pr edit 48 --body ...\nEOF";
// the first line names the failed command without the (potentially long) body.
function firstLine(err) {
  return String(err.message).split('\n')[0]
}

function withRetry(fn, log) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn()
    } catch (err) {
      if (!isTransient(err) || attempt >= MAX_GH_ATTEMPTS) {
        log(`create-pr: gh attempt ${attempt}/${MAX_GH_ATTEMPTS} failed: ${firstLine(err)}`)
        throw err
      }
      const delayMs = GH_RETRY_BASE_DELAY_MS * attempt
      log(
        `create-pr: gh attempt ${attempt}/${MAX_GH_ATTEMPTS} failed (transient): ${firstLine(err)} — retrying in ${delayMs}ms`,
      )
      sleepSync(delayMs)
    }
  }
}

function run(cmd, cmdArgs, opts = {}, log) {
  return withRetry(
    () =>
      execFileSync(cmd, cmdArgs, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      }).trim(),
    log,
  )
}

function tryRun(cmd, cmdArgs, opts = {}, log) {
  try {
    return run(cmd, cmdArgs, opts, log)
  } catch {
    return null
  }
}

// Default GhService backed by the real `gh` CLI. The token is injected into
// `process.env.GH_TOKEN` so that `gh` authenticates; the core logic never learns
// where the token came from.
export function createExecGhService(token, log = () => {}) {
  if (token) process.env.GH_TOKEN = token

  return {
    version() {
      return tryRun('gh', ['--version'], {}, log)
    },

    prList(head, base) {
      const out = tryRun(
        'gh',
        [
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
        ],
        {},
        log,
      )
      if (!out) return []
      try {
        return JSON.parse(out)
      } catch {
        return []
      }
    },

    prCreate(head, base, title, body) {
      return run(
        'gh',
        ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body],
        {},
        log,
      )
    },

    prEdit(number, body) {
      run('gh', ['pr', 'edit', String(number), '--body', body], {}, log)
    },

    prListUrls(head, base) {
      return tryRun(
        'gh',
        [
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
        ],
        {},
        log,
      )
    },
  }
}
