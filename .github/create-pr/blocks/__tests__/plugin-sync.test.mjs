// Lock-step guard between the repo-side user plugin and its unit-test fixture.
//
// `.github/create-pr/blocks/types.mjs` is the canonical, shipped classification
// source. `__tests__/fixtures/types.mjs` is a self-contained *mirror* of it,
// loaded by the user-plugin tests so the unit suite can exercise the real
// "template placeholder ⇄ plugin" alignment without touching the real repository
// filesystem. The two are documented as needing to stay in lock-step; this test
// fails loudly if the two implementations drift apart, so a change to one without
// the other is caught in the unit suite (which runs in CI), not only by the
// integration spec.
import { describe, it, expect } from 'vitest'
import realTypes from '../types.mjs'
import fixtureTypes from './fixtures/types.mjs'

// Heads covering every branch-prefix bucket plus the `misc`/fallback default.
const HEADS = [
  'feature/pipeline-test-improves',
  'fix/login-bug',
  'refactor/extract-helper',
  'test/add-coverage',
  'perf/speed-up',
  'ci/fix-workflow',
  'build/bump-deps',
  'chore/tidy',
  'docs/update-readme',
  'misc',
]

// No git service: classification is head-only and fully deterministic, so the two
// implementations MUST produce byte-identical output for the same input.
const ctxFor = (head) => ({ head, base: 'main', services: {} })

describe('user `types` plugin ⇄ fixture mirror (lock-step)', () => {
  for (const head of HEADS) {
    it(`renders identically for "${head}"`, async () => {
      const [real, fixture] = await Promise.all([
        realTypes(ctxFor(head)),
        fixtureTypes(ctxFor(head)),
      ])
      expect(fixture).toBe(real)
    })
  }

  it('both emit the same checkbox labels (defensive sanity)', async () => {
    const out = await realTypes(ctxFor('feature/x'))
    expect(out).toContain(
      '- [x] New feature (non-breaking change which adds functionality)',
    )
    expect(out).toContain('- [ ] Bug fix (non-breaking change which fixes an issue)')
  })
})
