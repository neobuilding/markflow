// Unit tests for the local-render CLI (cli-render.mjs).
//
// cli-render.mjs is the "preview locally" entry point: it parses CLI flags,
// reads the template (defaulting to the same path the Action uses) and the
// optional existing body into strings, then delegates to renderTemplate. These
// tests exercise that thin adapter against a real child process — covering both
// the fresh (create) and refresh scenarios, plus the default-template-path and
// missing-required-flag behaviors. The rendering itself is covered in
// render-template.test.mjs; here we assert the CLI wiring around it.
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, 'cli-render.mjs')
const REPO_ROOT = join(__dirname, '..', '..', '..')
const DEFAULT_TEMPLATE = join(REPO_ROOT, '.github', 'pull-request-template.md')

function runCli(args, cwd = REPO_ROOT) {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout, stderr })
    })
  })
}

describe('cli-render — local preview CLI', () => {
  it('exits 1 when --head is missing', async () => {
    const { code, stderr } = await runCli(['--no-git'])
    expect(code).toBe(1)
    expect(stderr).toContain('--head is required')
  })

  it('renders a FRESH body using the default template path when --template is omitted', async () => {
    // No --template: should fall back to the Action's default path and load the
    // real .github/pull-request-template.md (not the commits-only fallback).
    const { code, stdout } = await runCli(['--head', 'feature/my-branch', '--no-git'])
    expect(code).toBe(0)
    // The real repo template has an `AUTO:title` block; the commits-only fallback
    // would only have `AUTO:commits`. Presence of AUTO:title proves the default
    // template was loaded.
    expect(stdout).toContain('<!-- AUTO:title -->')
    expect(stdout).toContain('<!-- AUTO:commits -->')
  })

  it('renders a FRESH body from an explicitly passed --template', async () => {
    const { code, stdout } = await runCli([
      '--head',
      'feature/cli',
      '--template',
      DEFAULT_TEMPLATE,
      '--no-git',
    ])
    expect(code).toBe(0)
    expect(stdout).toContain('<!-- AUTO:title -->')
  })

  it('renders a REFRESH (merge) when --existing is supplied', async () => {
    // Sample existing PR body with a stale title + a human note outside the
    // blocks. The refresh must update the title block and preserve the note.
    const existing = [
      '<!-- AUTO:title -->',
      '# Stale Title',
      '<!-- /AUTO:title -->',
      '',
      'human note kept',
      '',
      '<!-- AUTO:commits -->',
      '## Commits',
      '',
      '- old commit',
      '<!-- /AUTO:commits -->',
      '',
    ].join('\n')

    const dir = mkdtempSync(join(tmpdir(), 'cli-render-'))
    const existingPath = join(dir, 'existing.md')
    writeFileSync(existingPath, existing, 'utf8')

    const { code, stdout } = await runCli([
      '--head',
      'feature/cli',
      '--existing',
      existingPath,
      '--no-git',
    ])
    expect(code).toBe(0)
    // Title block refreshed from the branch name; stale title gone.
    expect(stdout).toContain('# Cli')
    expect(stdout).not.toContain('Stale Title')
    // Human text outside the blocks preserved.
    expect(stdout).toContain('human note kept')
  })
})
