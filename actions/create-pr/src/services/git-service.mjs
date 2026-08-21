// GitService: all `git` CLI operations the PR action needs.
//
// This is the I/O boundary for "how do we talk to git?". The default
// implementation spawns `git` via `execFileSync`, but the interface lets tests
// inject a fake GitService and assert on the call sequence without a repo.
//
// Interface contract (all methods return strings or null, never throw on
// non-zero exit — callers decide what to do with null):
//   hasOrigin(): boolean                     — does `git remote` list `origin`?
//   fetchBase(base): string|null            — `git fetch origin <base>` (null on failure)
//   revParse(ref): string|null              — `git rev-parse --verify <ref>` (null if ref missing)
//   logRange(head, base): string             — `git log <base>..HEAD` subjects+hashes
//   logSubjects(head, base): string         — `git log <base>..HEAD` subjects only
//   lsRemote(branch): string|null           — `git ls-remote --heads origin <branch>`
import { execFileSync } from 'node:child_process'

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

// Default GitService backed by the real `git` CLI.
export function createExecGitService() {
  return {
    hasOrigin() {
      return run('git', ['remote']).split('\n').filter(Boolean).includes('origin')
    },

    fetchBase(base) {
      return tryRun('git', ['fetch', 'origin', base, '--quiet'])
    },

    revParse(ref) {
      return tryRun('git', ['rev-parse', '--verify', ref])
    },

    // `head` is unused by the default impl (the range uses HEAD, not the
    // branch name, so detached-HEAD CI checkouts work). It is kept in the
    // signature so a fake service can key on it.
    logRange(head, base) {
      return tryRun('git', ['log', '--no-merges', '--pretty=format:- %h %s', `${base}..HEAD`])
    },

    logSubjects(head, base) {
      return tryRun('git', ['log', '--no-merges', '--pretty=format:- %s', `${base}..HEAD`])
    },

    lsRemote(branch) {
      return tryRun('git', ['ls-remote', '--heads', 'origin', branch])
    },
  }
}
