// Unit tests for the single rendering entry point (render-template.mjs).
//
// renderTemplate integrates read-template(string) + git service + registry +
// ctx + fillAutoBlocks + buildBody(refresh) behind ONE function. These tests
// exercise the FULL integration path, but the git service is ALWAYS injected as
// a fake no test here shells out to real git (consistent with the project
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
import { tmpdir } from 'node:os'
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
    logSubjects: vi.fn(() => log),
    lsRemote: () => null,
  }
}

const ISSUE_AND_TYPE_TEMPLATE = [
  '<!-- AUTO:issue -->',
  '## Fixes #(issue number)',
  '{{issue}}',
  '<!-- /AUTO:issue -->',
  '',
  '<!-- AUTO:type -->',
  '## Type of Change',
  '{{types}}',
  '<!-- /AUTO:type -->',
  '',
  '<!-- AUTO:commits -->',
  '## Commits',
  '',
  '{{commits}}',
  '<!-- /AUTO:commits -->',
  '',
].join('\n')

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

  it('backfills template blocks added after the PR was created (regression: PR #58)', async () => {
    const grownTemplate = [
      SAMPLE_TEMPLATE.trimEnd(),
      '',
      '<!-- AUTO:screenshots-before -->',
      '## Screenshots',
      '',
      '### Before',
      '<!-- /AUTO:screenshots-before -->',
      '',
      '<!-- AUTO:screenshots-after -->',
      '### After',
      '<!-- /AUTO:screenshots-after -->',
      '',
    ].join('\n')
    // A PR body created from the OLD template: commits are stale and there are
    // no screenshots markers anywhere.
    const existing = [
      '<!-- AUTO:title -->',
      '# Ui refactor',
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
    const opts = {
      head: 'feature/ui-refactor',
      template: grownTemplate,
      git: makeFakeGit({ revParseValue: 'abc123' }),
    }

    const refreshed = await renderTemplate({ ...opts, existingBody: existing })

    // New blocks reach the existing PR body on a refresh.
    expect(refreshed).toContain('<!-- AUTO:screenshots-before -->')
    expect(refreshed).toContain('### Before')
    expect(refreshed).toContain('<!-- AUTO:screenshots-after -->')
    expect(refreshed).toContain('### After')
    // Old blocks are refreshed and human text is preserved.
    expect(refreshed).toContain('did a thing')
    expect(refreshed).not.toContain('- old commit')
    expect(refreshed).toContain('human note kept')
    // A second refresh is a no-op: no duplicated blocks, byte-identical body.
    expect(await renderTemplate({ ...opts, existingBody: refreshed })).toBe(refreshed)
  })

  it('preserves screenshots outside the markers on a refresh (regression: PR #58)', async () => {
    const template = [
      '<!-- AUTO:before -->',
      '### Before',
      '<!-- /AUTO:before -->',
      '',
      '<!-- AUTO:after -->',
      '### After',
      '<!-- /AUTO:after -->',
      '',
    ].join('\n')
    // Human content sits between the two AUTO blocks and after the last one.
    const existing = [
      '<!-- AUTO:before -->',
      '### Before',
      '<!-- /AUTO:before -->',
      '',
      '![before](b.png)',
      '',
      '<!-- AUTO:after -->',
      '### After',
      '<!-- /AUTO:after -->',
      '',
      '![after](a.png)',
    ].join('\n')
    const opts = { head: 'feature/x', template, noGit: true }

    const refreshed = await renderTemplate({ ...opts, existingBody: existing })

    expect(refreshed).toContain('![before](b.png)')
    expect(refreshed).toContain('![after](a.png)')
    // A second refresh is byte-identical: no reset, no duplicated blocks.
    expect(await renderTemplate({ ...opts, existingBody: refreshed })).toBe(refreshed)
  })

  it('honours the base option when resolving the commit range', async () => {
    const git = makeFakeGit({ revParseValue: 'abc123' })
    const body = await renderTemplate({
      head: 'feature/opts',
      base: 'develop',
      template: SAMPLE_TEMPLATE,
      git,
    })
    expect(git.revParse).toHaveBeenCalledWith('origin/develop')
    expect(body).toContain('# Opts')
    expect(body).toContain('did a thing')
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

  it('memoizes the injected git service so each method+args spawns at most once', async () => {
    // The built-in `issue` plugin and the user `types` plugin both pull raw commit
    // subjects via `services.git.logSubjects(head, base)` with identical arguments.
    // The memoization boundary must collapse those two calls into a single
    // underlying `git.logSubjects` invocation (cache hit on the 2nd) so plugins
    // stay cheap without the core having to pre-compute shared facts.
    const git = makeFakeGit({ revParseValue: 'abc123' })
    const body = await renderTemplate({
      head: 'fix/#123-login',
      base: 'main',
      template: ISSUE_AND_TYPE_TEMPLATE,
      git,
    })
    expect(git.logSubjects).toHaveBeenCalledTimes(1)
    expect(body).toContain('123') // issue plugin extracted #123 from the head
    expect(body).toContain('- [x] Bug fix') // types plugin ticked Bug fix (fix/ prefix)
    expect(body).toContain('## Commits') // commits block still rendered (logRange)
  })

  it('loads repo-side block plugins when the cwd is not the repo root', async () => {
    // Regression: `npm test` inside actions/create-pr and `local-test-render`
    // run with a different cwd than the Action. The default blocks dir used to
    // be resolved from process.cwd(), so the `types` plugin silently vanished
    // and {{types}} stayed verbatim in the body.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpdir())
    try {
      vi.resetModules()
      const { renderTemplate: freshRender } = await import('./render-template.mjs')
      const body = await freshRender({
        head: 'fix/#123-login',
        template: ISSUE_AND_TYPE_TEMPLATE,
        noGit: true,
      })
      expect(body).toContain('- [x] Bug fix')
      expect(body).not.toContain('{{types}}')
    } finally {
      cwdSpy.mockRestore()
      vi.resetModules()
    }
  })
})
