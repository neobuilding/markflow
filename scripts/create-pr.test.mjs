// Unit tests for scripts/create-pr.mjs pure logic.
//
// The script's side-effecting entry point (runMain) is NOT executed on import:
// it is guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`,
// and under vitest `process.argv[1]` is the test runner, not this script. So
// importing the module is safe and only the exported helpers are exercised.
import { describe, it, expect } from 'vitest'
import { deriveTitle, refreshCommitsSection, buildCommitsSection } from './create-pr.mjs'

// --- deriveTitle ---------------------------------------------------------
describe('deriveTitle', () => {
  it('strips a feature/ prefix and title-cases the first letter', () => {
    expect(deriveTitle('feature/pipeline-test-improves')).toBe('Pipeline test improves')
  })

  it('handles fix/ and other conventional prefixes case-insensitively', () => {
    // Only the FIRST character is upper-cased; the rest of the slug is preserved
    // as-is (so an already-mixed-case slug like LoginBug stays LoginBug).
    expect(deriveTitle('Fix/LoginBug')).toBe('LoginBug')
  })

  it('collapses hyphens, underscores and slashes into spaces', () => {
    expect(deriveTitle('chore/add_new__ci_hook')).toBe('Add new ci hook')
  })

  it('leaves a bare branch name untouched except casing the first letter', () => {
    expect(deriveTitle('my-branch')).toBe('My branch')
  })
})

// --- refreshCommitsSection ----------------------------------------------
describe('refreshCommitsSection', () => {
  const marker = '## Commits'
  const section = `${marker}\n\n- abc123 first commit\n- def456 second commit\n`

  it('appends the commits section when the body has none', () => {
    const out = refreshCommitsSection('Some human text', section)
    expect(out).toBe(`Some human text\n\n${section}`)
  })

  it('replaces only the old commits section, preserving text above the marker', () => {
    const oldBody = `Template text here\n\n${marker}\n\n- old111 stale commit\n`
    const out = refreshCommitsSection(oldBody, section)
    expect(out).toBe(`Template text here\n\n${section}`)
    expect(out).not.toContain('stale commit')
  })

  it('is idempotent: refreshing with the same section yields the same body', () => {
    const body = `Template\n\n${section}`
    expect(refreshCommitsSection(body, section)).toBe(body)
  })

  it('returns the body unchanged when there is no commit section to add', () => {
    expect(refreshCommitsSection('only template', '')).toBe('only template')
  })
})

// --- buildCommitsSection (inject a fake git-log) -------------------------
describe('buildCommitsSection', () => {
  it('wraps git-log output in a "## Commits" markdown list', () => {
    const fakeLog = () => '- abc1234 add auto pr script\n- def5678 wire up workflow\n'
    const out = buildCommitsSection('feature/x', 'main', fakeLog)
    expect(out).toContain('## Commits')
    expect(out).toContain('- abc1234 add auto pr script')
    expect(out).toContain('- def5678 wire up workflow')
  })

  it('returns an empty string when git log yields nothing', () => {
    expect(buildCommitsSection('feature/x', 'main', () => '')).toBe('')
  })
})
