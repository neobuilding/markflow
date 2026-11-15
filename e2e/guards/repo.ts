// Shared helpers for the contract guards. Not a test file: `vitest.config.ts` collects
// `e2e/**/*.test.ts`, which this name cannot match.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, derived from this file's location (same convention as launch.ts). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Read a repository-relative file as UTF-8. */
export const repoSource = (relPath: string): string => readFileSync(join(ROOT, relPath), 'utf-8')

/**
 * The `e2e:full` script split into its sequential invocations. Two invocations are load-bearing:
 * Playwright schedules the projects of ONE invocation concurrently, and the timing gate must not
 * share a machine with the app specs (ADR-0027).
 */
export function e2eFullInvocations(): string[] {
  const pkg = JSON.parse(repoSource('package.json')) as { scripts: Record<string, string> }
  return (pkg.scripts['e2e:full'] ?? '')
    .split('&&')
    .map((command) => command.trim())
    .filter(Boolean)
}

/**
 * Every `playwright test …` command line in a GitHub workflow.
 *
 * Parsed as lines rather than by counting substring occurrences: an occurrence count says nothing
 * about WHICH command carries which flags, and would stay green if one invocation were narrowed
 * while another were widened.
 *
 * Comment lines are dropped: a commented-out command is not a command the workflow runs. The
 * guard's own docstring promises this, so the filter lives here rather than at a call site.
 */
export function playwrightCommandsIn(workflow: string): string[] {
  return workflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .filter((line) => /\bplaywright test\b/.test(line))
}

/**
 * Convert a Playwright `testMatch` glob into a RegExp.
 *
 * Hand-rolled instead of `minimatch`: minimatch is only a transitive dependency here (it arrives
 * with Playwright), and depending on one makes an upgrade silently break this guard. Feeding a raw
 * glob to `new RegExp` is worse still — `**\/*.e2e.spec.ts` throws `Nothing to repeat`.
 *
 * A string pattern in Playwright is matched against the path the same way `**` and `*` behave in
 * globs: `**` spans path separators, `*` does not.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      // `**/` also matches zero directories, so `**/x` accepts `x` as well as `a/b/x`.
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}
