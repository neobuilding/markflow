// Unit tests for the single rendering entry point (render-template.mjs).
//
// renderTemplate integrates read-template(string) + git service + registry +
// ctx + fillAutoBlocks + buildBody(refresh) behind ONE function. These tests
// exercise the FULL integration path, but the git service is ALWAYS injected as
// a fake — no test here shells out to real git (consistent with the project
// rule that unit tests must not perform real I/O). The I/O boundary itself is
// covered separately in services/git-service.test.mjs (mocking exec-glue).
//
// Externally observable contract under test:
//   - it renders a body containing the derived title + commits block,
//   - it throws when `head` is missing,
//   - it falls back to a commits-only body when the template is empty,
//   - given an `existingBody`, it refreshes (merges) instead of returning fresh,
//   - resolveBaseRef's three branches are all covered via the injected git:
//       * injected git present and revParse succeeds  -> `origin/<base>`
//       * injected git present but revParse fails       -> `<base>`
//       * noGit (no git service)                        -> `<base>`
import { describe, it, expect, vi } from 'vitest'
import { renderTemplate } from './render-template.mjs'

// A fake git service. It never touches the filesystem or spawns a process; the
// tests decide what revParse / log* return. This is the git *caller* layer being
// tested, so we mock the whole git service (not exec-glue) per the mock-level
// rule.
function makeFakeGit({ revParseValue = null, log = '- deadbeef did a thing' } = {}) {
  return {
    revParse: vi.fn(() => revParseValue),
    hasOrigin: () => true,
    fetchBase: () => '',
    logRange: () => log,
    logSubjects: () => log,
    lsRemote: () => null,
  }
}

const SAMPLE_TEMPLATE = [
  '<!-- AUTO:title -->',
  '# {{title}}',
  '<!-- /AUTO:title -->',
  '',
  '<!-- AUTO:commits -->',
  '## Commits',
  '',
  '{{commits}}',
  '<!-- /AUTO:commits -->',
  '',
].join('\n')

describe('renderTemplate — single rendering entry point', () => {
  it('renders a body containing the derived title and the commits block', async () => {
    const body = await renderTemplate({
      head: 'feature/my-work',
      template: SAMPLE_TEMPLATE,
      git: makeFakeGit({ revParseValue: 'abc123' }),
    })
    // deriveTitle('feature/my-work') => 'My work'
    expect(body).toContain('# My work')
    expect(body).toContain('<!-- AUTO:commits -->')
    expect(body).toContain('did a thing')
  })

  it('throws when head is missing', async () => {
    await expect(renderTemplate({ template: SAMPLE_TEMPLATE, git: makeFakeGit() })).rejects.toThrow(
      '`head` is required',
    )
  })

  it('falls back to a commits-only body when the template is empty', async () => {
    const body = await renderTemplate({ head: 'feature/x', template: '', git: makeFakeGit() })
    expect(body).toContain('<!-- AUTO:commits -->')
  })

  it('refreshes an existing body by merging the fresh AUTO blocks', async () => {
    // Old body has a stale title and stale commits; a human note sits OUTSIDE
    // the blocks and must be preserved.
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

    const refreshed = await renderTemplate({
      head: 'feature/x',
      template: SAMPLE_TEMPLATE,
      existingBody: existing,
      git: makeFakeGit({ revParseValue: 'abc123' }),
    })

    // Title + commits blocks were refreshed to the fresh render.
    expect(refreshed).toContain('# X') // deriveTitle('feature/x') => 'X'
    expect(refreshed).toContain('## Commits')
    // Human text outside the blocks is preserved.
    expect(refreshed).toContain('human note kept')
    // The stale content is gone.
    expect(refreshed).not.toContain('Stale Title')
    expect(refreshed).not.toContain('- old commit')
  })

  it('passes options through (base, blocksDir) without error', async () => {
    const body = await renderTemplate({
      head: 'feature/opts',
      base: 'develop',
      template: SAMPLE_TEMPLATE,
      git: makeFakeGit({ revParseValue: 'abc123' }),
    })
    expect(typeof body).toBe('string')
    expect(body.length).toBeGreaterThan(0)
  })

  it('omits the git service and still renders when noGit is set', async () => {
    // Exercises the `if (!git) return base` branch in resolveBaseRef: with no
    // git service the base ref must fall back to the bare branch name and the
    // render must still succeed (the commits block renders empty).
    const body = await renderTemplate({
      head: 'feature/nogit',
      template: SAMPLE_TEMPLATE,
      noGit: true,
    })
    expect(body).toContain('# Nogit') // deriveTitle('feature/nogit') => 'Nogit'
    expect(body).toContain('<!-- AUTO:commits -->')
  })

  describe('resolveBaseRef branches (covered via injected git)', () => {
    it('uses `origin/<base>` when the injected git revParse succeeds', async () => {
      // revParse('origin/main') returns a non-null ref => truthy branch of the
      // ternary on render-template.mjs:46. This is the branch that was uncovered
      // on CI (where the real git had no origin/main ref). With an injected git
      // it is deterministic and covered everywhere.
      const git = makeFakeGit({ revParseValue: 'abc123' })
      const body = await renderTemplate({
        head: 'feature/x',
        base: 'main',
        template: SAMPLE_TEMPLATE,
        git,
      })
      expect(git.revParse).toHaveBeenCalledWith('origin/main')
      expect(body).toContain('## Commits')
    })

    it('falls back to `<base>` when the injected git revParse fails (null)', async () => {
      // revParse('origin/main') returns null => falsy branch of the ternary.
      const git = makeFakeGit({ revParseValue: null })
      const body = await renderTemplate({
        head: 'feature/x',
        base: 'main',
        template: SAMPLE_TEMPLATE,
        git,
      })
      expect(git.revParse).toHaveBeenCalledWith('origin/main')
      expect(body).toContain('## Commits')
    })
  })
})
