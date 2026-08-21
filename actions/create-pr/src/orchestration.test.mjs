// Unit tests for actions/create-pr/src/orchestration.mjs.
//
// These tests exercise the create-or-refresh-PR flow with FAKE services (no
// `git`, no `gh`, no filesystem, no token). The fakes record every call so we
// can assert on the exact sequence and arguments. This is the whole point of
// the decoupling: the orchestration logic is now fully unit-testable.
import { describe, it, expect, vi } from 'vitest'
import { createOrRefreshPr } from './orchestration.mjs'
import { fillAutoBlocks, deriveTitle } from './render.mjs'

// --- Fake services -------------------------------------------------------

// A fake GitService. Every method returns canned values; `calls` records the
// invocation sequence so tests can assert on it.
function fakeGit(opts = {}) {
  const calls = []
  // Helper: return opts[key] when explicitly set (even to null/false), else the
  // default. `??` would turn a deliberate `null` into the default, hiding the
  // "missing ref" test path.
  const pick = (k, d) => (opts[k] !== undefined ? opts[k] : d)
  return {
    calls,
    hasOrigin() {
      calls.push(['hasOrigin'])
      return pick('hasOrigin', true)
    },
    fetchBase(base) {
      calls.push(['fetchBase', base])
      return pick('fetchBase', '')
    },
    revParse(ref) {
      calls.push(['revParse', ref])
      return pick('revParse', 'abc123')
    },
    logRange(head, base) {
      calls.push(['logRange', head, base])
      return pick('logRange', '- h1 first commit\n- h2 second commit\n')
    },
    logSubjects(head, base) {
      calls.push(['logSubjects', head, base])
      return pick('logSubjects', '- first commit\n- second commit\n')
    },
    lsRemote(branch) {
      calls.push(['lsRemote', branch])
      return pick('lsRemote', 'ref-for-' + branch)
    },
  }
}

// A fake GhService. `prs` controls what prList returns; `createError` makes
// prCreate throw (to test the concurrency path); `calls` records everything.
function fakeGh(opts = {}) {
  const calls = []
  const pick = (k, d) => (opts[k] !== undefined ? opts[k] : d)
  return {
    calls,
    version() {
      calls.push(['version'])
      return pick('version', 'gh version 2.40.0')
    },
    prList(head, base) {
      calls.push(['prList', head, base])
      return pick('prs', [])
    },
    prCreate(head, base, title, body) {
      calls.push(['prCreate', head, base, title, body])
      if ('createError' in opts) throw opts.createError
      return pick('createUrl', 'https://github.com/owner/repo/pull/1')
    },
    prEdit(number, body) {
      calls.push(['prEdit', number, body])
      if ('editError' in opts) throw opts.editError
    },
    prListUrls(head, base) {
      calls.push(['prListUrls', head, base])
      return pick('concurrentUrl', null)
    },
  }
}

// A minimal block registry (title/issue/commits) for rendering. The `commits`
// plugin mirrors the real src/blocks/commits.mjs: it is autonomous and pulls
// the list from ctx.services.git.logRange.
function miniRegistry() {
  return {
    title: (ctx) => ctx.title || '',
    issue: (ctx) => ctx.fixes || 'N/A',
    commits: (ctx) => {
      const git = (ctx.services && ctx.services.git) || {}
      return git.logRange ? git.logRange(ctx.head, ctx.base) : ''
    },
  }
}

const TEMPLATE = [
  '<!-- AUTO:title -->',
  '# {{title}}',
  '<!-- /AUTO:title -->',
  '',
  '## Description',
  '',
  '<!-- AUTO:issue -->',
  '## Fixes',
  '',
  '{{issue}}',
  '<!-- /AUTO:issue -->',
  '',
  '<!-- AUTO:commits -->',
  '## Commits',
  '',
  '{{commits}}',
  '<!-- /AUTO:commits -->',
  '',
].join('\n')

// --- Tests ---------------------------------------------------------------

describe('createOrRefreshPr — create path', () => {
  it('creates a new PR when no existing PR is found', async () => {
    const git = fakeGit()
    const gh = fakeGh()
    const log = vi.fn()
    const result = await createOrRefreshPr({
      head: 'feature/new-thing',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log,
    })
    expect(result.action).toBe('created')
    expect(result.url).toBe('https://github.com/owner/repo/pull/1')
    // gh.prCreate was called with the derived title and a rendered body.
    const createCall = gh.calls.find((c) => c[0] === 'prCreate')
    expect(createCall[1]).toBe('feature/new-thing')
    expect(createCall[2]).toBe('main')
    expect(createCall[3]).toBe('New thing') // deriveTitle('feature/new-thing')
    expect(createCall[4]).toContain('# New thing')
    expect(createCall[4]).toContain('## Commits')
    expect(createCall[4]).toContain('- h1 first commit')
    // git.lsRemote was called to verify the branch exists on origin.
    expect(git.calls.some((c) => c[0] === 'lsRemote')).toBe(true)
  })

  it('dry-run returns would-create and does NOT call prCreate', async () => {
    const git = fakeGit()
    const gh = fakeGh()
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      dryRun: true,
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('would-create')
    expect(result.body).toContain('# X')
    expect(gh.calls.some((c) => c[0] === 'prCreate')).toBe(false)
  })

  it('falls back to bare base when revParse(origin/<base>) is missing', async () => {
    // resolveBaseRef returns `base` (not `origin/base`) when revParse is falsy.
    const git = fakeGit({ revParse: null })
    const gh = fakeGh()
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('created')
    // The commits plugin received the bare base (not origin/main) as ctx.base.
    const commitsCall = git.calls.find((c) => c[0] === 'logRange')
    expect(commitsCall[2]).toBe('main')
  })

  it('would-create with an empty derived title falls back to head', async () => {
    // head='' => deriveTitle('') = '' => `title || head` resolves to '' (the
    // right-hand fallback branch). Exercises the defensive `title || head`.
    const git = fakeGit({ revParse: null, lsRemote: 'ref' })
    const gh = fakeGh()
    const result = await createOrRefreshPr({
      head: '',
      base: 'main',
      dryRun: true,
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('would-create')
    expect(result.title).toBe('')
  })

  it('creates with an empty derived title (prCreate falls back to head)', async () => {
    const git = fakeGit({ revParse: null, lsRemote: 'ref' })
    const gh = fakeGh()
    const result = await createOrRefreshPr({
      head: '',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('created')
    const createCall = gh.calls.find((c) => c[0] === 'prCreate')
    expect(createCall[3]).toBe('') // title || head
  })
})

describe('createOrRefreshPr — update path', () => {
  it('updates an existing PR when the body changed', async () => {
    // Simulate an existing PR with a stale title, so the refreshed body differs.
    const existingBody = fillAutoBlocks(
      TEMPLATE,
      { head: 'feature/x', base: 'origin/main', title: 'Stale', fixes: '1', commits: '- old\n' },
      miniRegistry(),
    )
    const git = fakeGit({ logRange: '- h1 new commit\n' })
    const gh = fakeGh({
      prs: [{ number: 42, url: 'https://github.com/o/r/pull/42', body: existingBody }],
    })
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('updated')
    expect(result.url).toContain('pull/42')
    const editCall = gh.calls.find((c) => c[0] === 'prEdit')
    expect(editCall[1]).toBe(42)
    expect(editCall[2]).toContain('# X') // refreshed title
    expect(editCall[2]).not.toContain('Stale')
    expect(editCall[2]).toContain('- h1 new commit')
  })

  it('returns noop when the existing body is already up to date', async () => {
    // Build the "current" body using the SAME services the orchestration will
    // use: the commits plugin pulls the list from ctx.services.git.logRange, and
    // fixes/typeFlags derive from git.logSubjects. So the refreshed body matches
    // the existing one exactly => noop.
    const git = fakeGit() // default logRange/logSubjects
    const fresh = fillAutoBlocks(
      TEMPLATE,
      {
        head: 'feature/x',
        base: 'origin/main',
        title: deriveTitle('feature/x'),
        fixes: '', // extractFixes('feature/x', '- first\n- second\n') => ''
        services: { git }, // commits plugin renders git.logRange default
      },
      miniRegistry(),
    )
    const gh = fakeGh({
      prs: [{ number: 1, url: 'u', body: fresh }],
    })
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('noop')
    expect(gh.calls.some((c) => c[0] === 'prEdit')).toBe(false)
  })

  it('warns but continues when git fetchBase returns null (non-fatal)', async () => {
    const git = fakeGit({ fetchBase: null })
    const gh = fakeGh()
    const warn = vi.fn()
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
      warn,
    })
    // The flow still completes (created) despite the failed fetch.
    expect(result.action).toBe('created')
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain("could not fetch 'main'")
  })

  it('throws when prEdit fails (fatal edit error)', async () => {
    const git = fakeGit({ logRange: '- new\n' })
    const gh = fakeGh({
      prs: [{ number: 5, url: 'https://github.com/o/r/pull/5', body: 'old' }],
      editError: Object.assign(new Error('boom'), { stderr: 'gh edit failed' }),
    })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('failed to update the existing PR description')
  })

  it('surfaces the stdout (not just stderr) when prEdit fails', async () => {
    const git = fakeGit({ logRange: '- new\n' })
    const gh = fakeGh({
      prs: [{ number: 6, url: 'https://github.com/o/r/pull/6', body: 'old' }],
      editError: Object.assign(new Error('boom'), { stdout: 'gh edit stdout' }),
    })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('gh edit stdout')
  })

  it('falls back to err.message when prEdit fails with a plain error', async () => {
    const git = fakeGit({ logRange: '- new\n' })
    const gh = fakeGh({
      prs: [{ number: 7, url: 'https://github.com/o/r/pull/7', body: 'old' }],
      editError: new Error('plain edit failure'),
    })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('plain edit failure')
  })

  it('handles a falsy (null) error thrown by prEdit', async () => {
    const git = fakeGit({ logRange: '- new\n' })
    const gh = fakeGh({
      prs: [{ number: 8, url: 'https://github.com/o/r/pull/8', body: 'old' }],
      editError: null,
    })
    // `err && ...` short-circuits on the falsy null; fail() still throws.
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('failed to update the existing PR description')
  })

  it('dry-run returns would-update and does NOT call prEdit', async () => {
    const git = fakeGit({ logRange: '- new\n' })
    const gh = fakeGh({
      prs: [{ number: 5, url: 'u', body: 'old stale body' }],
    })
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      dryRun: true,
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('would-update')
    expect(result.number).toBe(5)
    expect(gh.calls.some((c) => c[0] === 'prEdit')).toBe(false)
  })
})

describe('createOrRefreshPr — concurrency path', () => {
  it('treats a prCreate failure with a concurrent PR as success', async () => {
    const git = fakeGit()
    const gh = fakeGh({
      createError: Object.assign(new Error('boom'), { stderr: 'gh error' }),
      concurrentUrl: 'https://github.com/o/r/pull/9',
    })
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      template: TEMPLATE,
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('concurrent')
    expect(result.url).toBe('https://github.com/o/r/pull/9')
  })

  it('throws when prCreate fails and no concurrent PR exists', async () => {
    const git = fakeGit()
    const gh = fakeGh({
      createError: Object.assign(new Error('boom'), { stderr: 'gh error' }),
      concurrentUrl: null,
    })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('failed to create the PR')
  })

  it('surfaces stdout (not just stderr) when prCreate fails', async () => {
    const git = fakeGit()
    const log = vi.fn()
    const gh = fakeGh({
      createError: Object.assign(new Error('boom'), { stdout: 'gh create stdout' }),
      concurrentUrl: null,
    })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log,
      }),
    ).rejects.toThrow('failed to create the PR')
    // The stdout detail is logged (the `err.stderr || err.stdout` branch).
    expect(String(log.mock.calls.at(-1)[0])).toContain('gh create stdout')
  })

  it('falls back to err.message when prCreate fails with a plain error', async () => {
    const git = fakeGit()
    const log = vi.fn()
    const gh = fakeGh({
      createError: new Error('plain create failure'),
      concurrentUrl: null,
    })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log,
      }),
    ).rejects.toThrow('failed to create the PR')
    // The message detail is logged (the `err?.message || err` branch).
    expect(String(log.mock.calls.at(-1)[0])).toContain('plain create failure')
  })

  it('handles a falsy (null) error thrown by prCreate', async () => {
    const git = fakeGit()
    const gh = fakeGh({
      createError: null,
      concurrentUrl: null,
    })
    // `err && ...` short-circuits on the falsy null; fail() still throws.
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        base: 'main',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('failed to create the PR')
  })
})

describe('createOrRefreshPr — failure paths', () => {
  it('throws when gh is not installed', async () => {
    const git = fakeGit()
    const gh = fakeGh({ version: null })
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow("GitHub CLI ('gh') is not installed")
  })

  it('throws when origin remote is missing', async () => {
    const git = fakeGit({ hasOrigin: false })
    const gh = fakeGh()
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow("no 'origin' remote configured")
  })

  it('throws when the head branch is not on origin', async () => {
    const git = fakeGit({ lsRemote: null })
    const gh = fakeGh()
    await expect(
      createOrRefreshPr({
        head: 'feature/missing',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('is not found on origin')
  })

  it('throws when git service is missing', async () => {
    const gh = fakeGh()
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        template: TEMPLATE,
        registry: miniRegistry(),
        gh,
        log: vi.fn(),
      }),
    ).rejects.toThrow('git service is required')
  })

  it('throws when gh service is missing', async () => {
    const git = fakeGit()
    await expect(
      createOrRefreshPr({
        head: 'feature/x',
        template: TEMPLATE,
        registry: miniRegistry(),
        git,
        log: vi.fn(),
      }),
    ).rejects.toThrow('gh service is required')
  })
})

describe('createOrRefreshPr — template handling', () => {
  it('falls back to commits-only body when template is null', async () => {
    const git = fakeGit()
    const gh = fakeGh()
    const result = await createOrRefreshPr({
      head: 'feature/x',
      base: 'main',
      template: null, // no template
      registry: miniRegistry(),
      git,
      gh,
      log: vi.fn(),
    })
    expect(result.action).toBe('created')
    const createCall = gh.calls.find((c) => c[0] === 'prCreate')
    // Without a real template, orchestration falls back to a minimal AUTO block
    // so the `commits` plugin can still render the commit list from git. The
    // AUTO:commits marker is expected (it's what the renderer keys on).
    expect(createCall[4]).toContain('<!-- AUTO:commits -->')
    expect(createCall[4]).toContain('- h1 first commit')
    expect(createCall[4]).not.toContain('## Commits')
  })
})
