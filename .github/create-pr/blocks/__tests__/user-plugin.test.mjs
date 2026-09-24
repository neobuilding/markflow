// Unit tests for the user `types` plugin's classification logic.
//
// `.github/create-pr/blocks/types.mjs` is the canonical, shipped classification
// source, but it does NOT export `classifyChange` (it inlines the function so the
// plugin stays a standalone, user-editable file that the action can load from an
// arbitrary repo without bundling `src/`). The classification is therefore
// exercised through this fixture mirror, which exports `classifyChange` and is
// kept in lock-step with the real plugin by plugin-sync.test.mjs.
import { describe, it, expect } from 'vitest'
import { classifyChange } from './fixtures/types.mjs'

describe('classifyChange', () => {
  it('ticks Bug fix for a fix/ branch', () => {
    expect(classifyChange('fix/login', 'fix: handle null')).toEqual({
      bug: true,
      feature: false,
      refactor: false,
      test: false,
      improvement: false,
      docs: false,
      breaking: false,
    })
  })

  it('ticks New feature for a feature/ branch', () => {
    const f = classifyChange('feature/foo', 'feat: add x')
    expect(f.feature).toBe(true)
    expect(f.bug).toBe(false)
    expect(f.test).toBe(false)
  })

  it('ticks Refactor for a refactor/ branch', () => {
    const f = classifyChange('refactor/api', 'refactor: extract helper')
    expect(f.refactor).toBe(true)
    expect(f.feature).toBe(false)
    expect(f.bug).toBe(false)
  })

  it('ticks Tests for a test/ branch', () => {
    const f = classifyChange('test/coverage', 'test: add cases')
    expect(f.test).toBe(true)
  })

  it('aggregates perf/ci/build/chore into the improvement bucket', () => {
    expect(classifyChange('perf/render', '').improvement).toBe(true)
    expect(classifyChange('ci/workflow', '').improvement).toBe(true)
    expect(classifyChange('build/deps', '').improvement).toBe(true)
    expect(classifyChange('chore/tidy', '').improvement).toBe(true)
  })

  it('ticks Documentation for a docs/ branch', () => {
    expect(classifyChange('docs/readme', 'docs: update').docs).toBe(true)
  })

  it('detects Breaking change from a "!" conventional-commit marker', () => {
    const f = classifyChange('feature/foo', 'feat!: breaking change')
    expect(f.breaking).toBe(true)
    expect(f.feature).toBe(true)
  })

  it('detects Breaking change from the word "breaking" anywhere', () => {
    expect(classifyChange('fix/foo', 'fix: a breaking tweak').breaking).toBe(true)
  })

  it('does NOT mis-tick Tests from a branch name containing the word "test"', () => {
    const f = classifyChange('feature/pipeline-test-improves', '')
    expect(f.feature).toBe(true)
    expect(f.test).toBe(false)
  })

  it('ignores conventional types outside the taxonomy and falls back to Bug fix', () => {
    const f = classifyChange('misc', 'update: tweak wording')
    expect(f.bug).toBe(true)
    expect(f.docs).toBe(false)
  })

  it('defaults to Bug fix when nothing matches', () => {
    expect(classifyChange('misc', 'wip').bug).toBe(true)
  })
})
