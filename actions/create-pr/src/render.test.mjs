// Unit tests for actions/create-pr/src/render.mjs pure logic.
//
// render.mjs is 100% pure (zero I/O, zero @actions/core, zero execFileSync).
// The block-plugin loading (loadBlocks) lives in loader.mjs (file IO + dynamic
// import) and is exercised by loader.test.mjs; the orchestration flow
// (createOrRefreshPr) is exercised by orchestration.test.mjs with fake services.
//
// IMPORTANT (post-refactor): the render core knows NOTHING about PR type or
// linked issue. Those facts are derived by the `types` / `issue` plugins from
// `ctx.services.git`. So these tests never pass `typeFlags`/`fixes` into the
// context; they drive classification by supplying `head` + a fake `git` service,
// exactly like production.
import { describe, it, expect, vi } from 'vitest'
import {
  deriveTitle,
  buildCommitsSection,
  buildDescription,
  fillAutoBlocks,
  replaceAutoBlock,
  blockContent,
  buildBody,
  markersFor,
  renderBlock,
  discoverSegments,
  buildCtx,
} from './render.mjs'
// Mock the fs boundary so no test reads from (or depends on) the real repo
// filesystem at runtime. The template content is supplied INLINE by the mock
// (PR_TEMPLATE, a verbatim copy of .github/pull-request-template.md, hoisted so
// the module-level `readFileSync(...)` call below sees it). The block-plugin
// loading below still uses loader.mjs's real dynamic import() against a fixture
// directory (module loading, not file I/O). existsSync is stubbed true because
// the fixture directories are real test assets.
const { readFileSync, existsSync, readdirSync, PR_TEMPLATE } = vi.hoisted(() => {
  const prTemplate = [
    '<!-- AUTO:title -->',
    '# {{title}}',
    '<!-- /AUTO:title -->',
    '',
    '## Description',
    '',
    'Please include a summary of the change and which issue is fixed. Please also include relevant motivation and context.',
    '',
    '<!-- AUTO:type -->',
    '## Type of Change',
    '',
    '{{types}}',
    '<!-- /AUTO:type -->',
    '',
    '<!-- AUTO:checklist -->',
    '## Checklist',
    '',
    '- [ ] My code follows the style guidelines of this project',
    '- [ ] I have performed a self-review of my own code',
    '- [ ] I have commented my code, particularly in hard-to-understand areas',
    '- [ ] I have made corresponding changes to the documentation',
    '- [ ] My changes generate no new warnings',
    '- [ ] I ran `npm run quality` locally and it passes (Prettier + Stylelint + Markdownlint + Secretlint)',
    '- [ ] I have added tests that prove my fix is effective or that my feature works',
    '- [ ] New and existing unit tests pass locally with my changes',
    '<!-- /AUTO:checklist -->',
    '',
    '<!-- AUTO:issue -->',
    '## Fixes #(issue number)',
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
  // readdirSync is stubbed to the fixture listing so loader.mjs's dynamic
  // import() resolves the real fixture plugins without touching the real repo.
  return {
    readFileSync: vi.fn(() => prTemplate),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn((dir) => {
      const builtinBlocks = join(__dirname, '..', 'blocks')
      const userFixture = join(
        __dirname,
        '..',
        '..',
        '..',
        '.github',
        'create-pr',
        'blocks',
        '__tests__',
        'fixtures',
      )
      if (dir === userFixture) return ['types.mjs']
      if (dir === builtinBlocks) return ['title.mjs', 'issue.mjs', 'commits.mjs']
      return []
    }),
    PR_TEMPLATE: prTemplate,
  }
})
vi.mock('./services/fs-glue.mjs', () => ({
  readFileSync,
  existsSync,
  readdirSync,
}))

// --- PR template integrity ----------------------------------------------
describe('PR template integrity', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  it('has exactly one open+close marker per auto block (title/type/issue/checklist/commits)', () => {
    for (const key of ['title', 'type', 'issue', 'checklist', 'commits']) {
      const { open, close } = markersFor(key)
      expect(
        tpl.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [],
      ).toHaveLength(1)
      expect(
        tpl.match(new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [],
      ).toHaveLength(1)
    }
  })

  it('no longer carries the legacy outer AUTO-GENERATED markers', () => {
    expect(tpl).not.toContain('AUTO-GENERATED-START')
    expect(tpl).not.toContain('AUTO-GENERATED-END')
  })

  it('has no {{description}} or {{tested}} placeholders (removed)', () => {
    expect(tpl).not.toContain('{{description}}')
    expect(tpl).not.toContain('{{tested}}')
  })

  it('keeps the Description as a human-only region (outside blocks)', () => {
    expect(tpl).toContain('## Description')
    expect(tpl).not.toContain('<!-- AUTO:description')
  })

  it('defines every auto block, including the Checklist', () => {
    for (const key of ['title', 'type', 'issue', 'checklist', 'commits']) {
      const { open, close } = markersFor(key)
      expect(tpl).toContain(open)
      expect(tpl).toContain(close)
    }
    expect(tpl).toContain('{{title}}')
    expect(tpl).toContain('{{issue}}')
    expect(tpl).toContain('{{commits}}')
  })

  it('uses the {{types}} placeholder (not hand-written checkbox lines) in the type block', () => {
    expect(tpl).toContain('<!-- AUTO:type -->')
    expect(tpl).toContain('{{types}}')
    expect(tpl).not.toContain('- [ ] Bug fix (non-breaking change which fixes an issue)')
  })
})

// --- deriveTitle ---------------------------------------------------------
describe('deriveTitle', () => {
  it('strips a feature/ prefix and title-cases the first letter', () => {
    expect(deriveTitle('feature/pipeline-test-improves')).toBe('Pipeline test improves')
  })

  it('handles fix/ and other conventional prefixes case-insitively', () => {
    expect(deriveTitle('Fix/LoginBug')).toBe('LoginBug')
  })

  it('collapses hyphens, underscores and slashes into spaces', () => {
    expect(deriveTitle('chore/add_new__ci_hook')).toBe('Add new ci hook')
  })

  it('leaves a bare branch name untouched except casing the first letter', () => {
    expect(deriveTitle('my-branch')).toBe('My branch')
  })
})

// --- buildCommitsSection (inject a fake git-log) -------------------------
// render.mjs buildCommitsSection NEVER calls git on its own it returns '' when
// no gitLogFn is given. The caller (orchestration.mjs) injects git.logRange.
describe('buildCommitsSection', () => {
  it('returns the commit list without a "## Commits" heading when a gitLogFn is provided', () => {
    const fakeLog = () => '- abc1234 add auto pr script\n- def5678 wire up workflow\n'
    const out = buildCommitsSection('feature/x', 'origin/main', fakeLog)
    expect(out).not.toContain('## Commits')
    expect(out).toContain('- abc1234 add auto pr script')
    expect(out).toContain('- def5678 wire up workflow')
  })

  it('returns an empty string when git log yields nothing', () => {
    expect(buildCommitsSection('feature/x', 'origin/main', () => '')).toBe('')
  })

  it('returns an empty string when no gitLogFn is provided (pure, never spawns git)', () => {
    expect(buildCommitsSection('feature/x', 'origin/main')).toBe('')
  })
})

// --- buildDescription (inject a fake git-log) ---------------------------
describe('buildDescription', () => {
  it('lists commit subjects without hashes', () => {
    const fakeLog = () => '- add auto pr script\n- wire up workflow\n'
    const out = buildDescription('feature/x', 'origin/main', fakeLog)
    expect(out).toContain('- add auto pr script')
    expect(out).not.toContain('abc1234')
  })

  it('returns empty when there are no commits', () => {
    expect(buildDescription('feature/x', 'origin/main', () => '')).toBe('')
  })

  it('returns empty when no gitLogFn is provided (pure, never spawns git)', () => {
    expect(buildDescription('feature/x', 'origin/main')).toBe('')
  })
})

// --- markers / replaceAutoBlock / blockContent --------------------------
describe('auto block markers', () => {
  it('markersFor builds symmetric open/close markers', () => {
    expect(markersFor('commits')).toEqual({
      open: '<!-- AUTO:commits -->',
      close: '<!-- /AUTO:commits -->',
    })
  })

  it("replaceAutoBlock swaps a block's inner content by key", () => {
    const body = 'head\n\n<!-- AUTO:issue -->\nold\n<!-- /AUTO:issue -->\n\nfoot'
    const out = replaceAutoBlock(body, 'issue', '42')
    expect(out).toBe('head\n\n<!-- AUTO:issue -->\n42\n<!-- /AUTO:issue -->\n\nfoot')
  })

  it('replaceAutoBlock is a no-op when the block is absent (never drops human text)', () => {
    const body = 'no blocks here'
    expect(replaceAutoBlock(body, 'issue', '42')).toBe(body)
  })

  it('blockContent extracts inner content, or null when missing', () => {
    const body = '<!-- AUTO:title -->\n# Hello\n<!-- /AUTO:title -->'
    expect(blockContent(body, 'title')).toBe('# Hello')
    expect(blockContent(body, 'commits')).toBe(null)
  })
})

// --- renderBlock (the universal plugin renderer) ------------------------
describe('renderBlock', () => {
  it('renders a registered block plugin, passing ctx', async () => {
    const reg = { greet: (ctx) => `hi ${ctx.name}` }
    expect(await renderBlock('greet', { name: 'x' }, reg)).toBe('hi x')
  })

  it('awaits an async plugin', async () => {
    const reg = { greet: async (ctx) => `hi ${ctx.name}` }
    expect(await renderBlock('greet', { name: 'y' }, reg)).toBe('hi y')
  })

  it('returns the {{name}} placeholder untouched when no plugin is registered', async () => {
    expect(await renderBlock('missing', {}, {})).toBe('{{missing}}')
    expect(await renderBlock('missing', {}, undefined)).toBe('{{missing}}')
  })

  it('returns the {{name}} placeholder (untouched) when the plugin throws', async () => {
    const reg = {
      bad: () => {
        throw new Error('boom')
      },
    }
    expect(await renderBlock('bad', {}, reg)).toBe('{{bad}}')
  })
})

// --- discoverSegments ----------------------------------------------------
describe('discoverSegments', () => {
  it('extracts every AUTO:key marker key in document order', () => {
    const tpl = ['<!-- AUTO:title -->', '<!-- AUTO:issue -->', '<!-- AUTO:commits -->'].join('\n')
    expect(discoverSegments(tpl)).toEqual(['title', 'issue', 'commits'])
  })

  it('returns an empty list when the template has no markers', () => {
    expect(discoverSegments('just plain text, no markers')).toEqual([])
  })

  it('de-duplicates repeated keys (first occurrence wins)', () => {
    const tpl = '<!-- AUTO:x -->\na\n<!-- /AUTO:x -->\nxxx\n<!-- AUTO:x -->\nb\n<!-- /AUTO:x -->'
    expect(discoverSegments(tpl)).toEqual(['x'])
  })
})

// --- fillAutoBlocks ------------------------------------------------------
describe('fillAutoBlocks', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  it('fills title, issue, commits and renders the types block via the registry', async () => {
    const out = await fillAutoBlocks(
      tpl,
      {
        head: 'fix/#42-login',
        base: 'origin/main',
        title: '#42 login',
        services: {
          git: {
            logRange: () => '- abc1234 did a thing\n',
            logSubjects: () => '- fix: handle null token\n',
          },
        },
      },
      await realMarkflowRegistry(),
    )
    expect(blockContent(out, 'title')).toBe('# #42 login')
    expect(blockContent(out, 'issue')).toContain('42')
    expect(blockContent(out, 'issue')).not.toContain('N/A')
    expect(blockContent(out, 'commits')).toContain('## Commits')
    expect(blockContent(out, 'commits')).toContain('- abc1234 did a thing')
    expect(blockContent(out, 'type')).toContain(
      '- [x] Bug fix (non-breaking change which fixes an issue)',
    )
  })

  it('shows "N/A" as the issue value when none is referenced (issue plugin policy)', async () => {
    const out = await fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'T',
        services: { git: { logRange: () => '', logSubjects: () => '' } },
      },
      await realMarkflowRegistry(),
    )
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\nN/A')
  })

  it('preserves the human Description region but resets the Checklist block to template state', async () => {
    const out = await fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'T',
        services: { git: { logRange: () => '', logSubjects: () => '' } },
      },
      await realMarkflowRegistry(),
    )
    expect(out).toContain('## Description')
    expect(blockContent(out, 'checklist')).toContain('## Checklist')
    expect(blockContent(out, 'checklist')).toContain('- [ ] My code follows the style guidelines')
  })

  it('renders an empty title block when no title is provided', async () => {
    const out = await fillAutoBlocks(
      tpl,
      {
        head: '',
        base: 'origin/main',
        title: '',
        services: { git: { logRange: () => '', logSubjects: () => '' } },
      },
      await realMarkflowRegistry(),
    )
    expect(blockContent(out, 'title')).toBe('#')
  })

  it('leaves {{name}} untouched when no plugin is registered for it', async () => {
    const localTpl = '<!-- AUTO:custom -->\n## Custom\n\n{{custom}}\n<!-- /AUTO:custom -->'
    const out = await fillAutoBlocks(localTpl, {}, {})
    expect(blockContent(out, 'custom')).toBe('## Custom\n\n{{custom}}')
  })

  it('renders every occurrence of a {{placeholder}} inside a block (global)', async () => {
    const localTpl = '<!-- AUTO:x -->\n{{v}} and {{v}}\n<!-- /AUTO:x -->'
    const out = await fillAutoBlocks(localTpl, {}, { v: () => 'VAL' })
    expect(blockContent(out, 'x')).toBe('VAL and VAL')
  })

  it('a template with no AUTO markers is used verbatim (no rendering)', async () => {
    const plain = 'Just plain text.\nNo markers here.'
    const reg = await realMarkflowRegistry()
    expect(await fillAutoBlocks(plain, { title: 'X' }, reg)).toBe(plain)
  })
})

// --- buildBody -----------------------------------------------------------
describe('buildBody', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  async function fill(ctx) {
    const reg = await realMarkflowRegistry()
    return fillAutoBlocks(tpl, { head: 'feature/auto-pr', base: 'origin/main', ...ctx }, reg)
  }

  it('returns the filled template alone on first creation (no existing body)', async () => {
    const filled = await fill({
      title: 'Auto pr',
      services: { git: { logRange: () => '- a1 add\n', logSubjects: () => '' } },
    })
    expect(buildBody(filled, '')).toBe(filled)
  })

  it('refreshes each auto block but preserves human text outside the blocks', async () => {
    const filled = await fill({
      title: 'Fresh Title',
      services: { git: { logRange: () => '- a1 add\n', logSubjects: () => '' } },
    })
    const stale = await fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'Stale Title',
        services: { git: { logRange: () => '- old commit\n', logSubjects: () => '' } },
      },
      await realMarkflowRegistry(),
    )
    const existingBody = `human note above\n\n${stale}\n\nhuman note below`
    const out = buildBody(filled, existingBody)
    expect(out).toContain('human note above')
    expect(out).toContain('human note below')
    expect(blockContent(out, 'title')).toBe('# Fresh Title')
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\nN/A')
    expect(blockContent(out, 'commits')).toContain('## Commits')
    expect(blockContent(out, 'commits')).toContain('- a1 add')
    expect(out).not.toContain('Stale Title')
    expect(out).not.toContain('- old commit')
    expect(out).toContain('## Description')
    expect(blockContent(out, 'checklist')).toContain('## Checklist')
    expect(blockContent(out, 'checklist')).toContain('- [ ] My code follows the style guidelines')
  })

  it('A2: prepends filled template and keeps the whole legacy body when no blocks exist', async () => {
    const filled = await fill({
      title: 'Auto pr',
      services: { git: { logRange: () => '- a1 add\n', logSubjects: () => '' } },
    })
    const legacy = '## Checklist\n\n- [x] reviewed\n\nSome human context here'
    const out = buildBody(filled, legacy)
    expect(out.startsWith('<!-- AUTO:title -->')).toBe(true)
    expect(out).toContain('- [x] reviewed')
    expect(out).toContain('Some human context here')
  })

  it('refreshes a CUSTOM auto block key (not in any hard-coded list) on update', async () => {
    const customTpl =
      '<!-- AUTO:title -->\n# {{title}}\n<!-- /AUTO:title -->\n\n' +
      '<!-- AUTO:security -->\n## Security\n\n{{security}}\n<!-- /AUTO:security -->'
    const freshCtx = { title: 'Fresh', security: 'scanned' }
    const filled = await fillAutoBlocks(customTpl, freshCtx, {
      title: (c) => c.title,
      security: (c) => c.security,
    })
    const stale = await fillAutoBlocks(
      customTpl,
      { title: 'Stale', security: 'UNSCANNED' },
      {
        title: (c) => c.title,
        security: (c) => c.security,
      },
    )
    const out = buildBody(filled, stale)
    expect(blockContent(out, 'title')).toBe('# Fresh')
    expect(blockContent(out, 'security')).toBe('## Security\n\nscanned')
    expect(out).not.toContain('UNSCANNED')
  })

  it('skips a block when it is absent from the fresh template (leaves existing block intact)', async () => {
    const filled = await fill({
      title: 'Auto pr',
      services: { git: { logRange: () => '- a1 add\n', logSubjects: () => '' } },
    })
    const filledNoCommits = filled.replace(
      /<!-- AUTO:commits -->[\s\S]*?<!-- \/AUTO:commits -->/,
      '',
    )
    const existingBody = `human above\n\n${filled}\n\nhuman below`
    const out = buildBody(filledNoCommits, existingBody)
    expect(out).toContain('- a1 add')
  })
})

// --- end-to-end rendering via the real template + the dynamically loaded fixture plugin ---
//
// These helpers render the actual `.github/pull-request-template.md` markup (the
// inlined PR_TEMPLATE) through `fillAutoBlocks` using the *real* built-in
// plugins plus the fixture `types` plugin loaded by loader.mjs's dynamic
// import(). They assert the rendered body end-to-end, including that the
// placeholder ⇄ plugin alignment holds. No real filesystem or git access occurs:
// the template is delivered via the mocked fs-glue `readFileSync`, and the git
// service is a fake injected through `ctx.services`.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBlocks } from './loader.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Build a registry that mirrors production: the action's built-in blocks
// (actions/create-pr/blocks/) PLUS the user `types` plugin loaded from its
// committed fixture mirror (`.github/create-pr/blocks/__tests__/fixtures/`).
// Both are loaded through the core loader (real dynamic import()) so the engine
// exercises the same registry-assembly path as production — no plugin file is
// statically imported into this core test.
const BUILTIN_BLOCKS = join(__dirname, '..', 'blocks')
const USER_PLUGIN_FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  '.github',
  'create-pr',
  'blocks',
  '__tests__',
  'fixtures',
)

async function realMarkflowRegistry() {
  const builtins = await loadBlocks(BUILTIN_BLOCKS)
  const user = await loadBlocks(USER_PLUGIN_FIXTURE)
  return { ...builtins, ...user }
}

// The path handed to the mocked readFileSync; its value is irrelevant because
// the mock returns PR_TEMPLATE regardless of the argument (no real fs access).
const TEMPLATE_PATH = '<mocked-template-path>'

// Render a full PR body for a given head/commits, injecting a fake git service
// (no real git). Classification (type boxes) and the linked issue are derived
// by the plugins from `ctx.services.git`, exactly like production.
async function renderFullPr({ head, base = 'origin/main', title, commits = '' }) {
  const registry = await realMarkflowRegistry()
  // The template is delivered via the mocked fs-glue readFileSync (no real
  // filesystem access); supply the inlined PR_TEMPLATE as its return value.
  readFileSync.mockReturnValue(PR_TEMPLATE)
  const tpl = readFileSync(TEMPLATE_PATH, 'utf8')
  const ctx = {
    head,
    base,
    title: title ?? deriveTitle(head),
    // No `typeFlags`/`fixes` here on purpose: the plugins derive those from the
    // git service, exactly like production. Tests drive classification via `head`
    // + the injected `git` service.
    services: { git: { logRange: () => commits, logSubjects: () => commits } },
  }
  return fillAutoBlocks(tpl, ctx, registry)
}

function blocksOf(body) {
  const keys = discoverSegments(body)
  const out = { outside: body }
  for (const k of keys) out[k] = blockContent(body, k)
  return out
}

describe('完整 PR 模板本地渲染（端到端）', () => {
  it('feature/ 分支：标题来自分支名，feature 框勾选，issue 为 N/A', async () => {
    const body = await renderFullPr({
      head: 'feature/pipeline-test-improves',
      commits: '- a1 add pipeline test\n- a2 improves coverage\n',
    })
    const b = blocksOf(body)
    expect(b.title).toBe('# Pipeline test improves')
    expect(b.type).toContain('- [x] New feature (non-breaking change which adds functionality)')
    expect(b.type).not.toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
    expect(b.issue).toContain('N/A')
    expect(b.commits).toContain('## Commits')
    expect(b.commits).toContain('- a1 add pipeline test')
    expect(b.commits).toContain('- a2 improves coverage')
    expect(b.outside).toContain('## Description')
    expect(b.checklist).toContain('## Checklist')
  })

  it('fix/#123 分支：标题保留 issue 引用、Bug 框勾选、issue 显式渲染为 123', async () => {
    const body = await renderFullPr({
      head: 'fix/#123-login',
      commits: '- b1 handle null token\n',
    })
    const b = blocksOf(body)
    expect(b.title).toBe('# #123 login')
    expect(b.type).toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
    expect(b.issue).toContain('123')
    expect(b.issue).not.toContain('N/A')
    expect(b.commits).toContain('- b1 handle null token')
  })

  it('docs/ 分支：只勾 Documentation 框（其余留空）', async () => {
    const body = await renderFullPr({ head: 'docs/update-readme' })
    const b = blocksOf(body)
    expect(b.type).toContain('- [x] Documentation update')
    expect(b.type).not.toContain('- [x] New feature (non-breaking change which adds functionality)')
    expect(b.type).not.toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
  })

  it('refactor/ 分支：只勾 Refactor 框（feature/test 不误命中）', async () => {
    const body = await renderFullPr({ head: 'refactor/extract-helper' })
    const b = blocksOf(body)
    expect(b.type).toContain(
      '- [x] Refactor (code change that neither fixes a bug nor adds a feature)',
    )
    expect(b.type).not.toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
    expect(b.type).not.toContain('- [x] New feature (non-breaking change which adds functionality)')
    expect(b.type).not.toContain('- [x] Tests (adding or updating tests)')
  })

  it('perf/ 分支：勾选 Performance / technical improvement（improvement 桶）', async () => {
    const body = await renderFullPr({ head: 'perf/speed-up-render' })
    const b = blocksOf(body)
    expect(b.type).toContain(
      '- [x] Performance / technical improvement (perf, CI, build, chore, or other internal improvement)',
    )
    expect(b.type).not.toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
  })

  it('ci/、build/、chore/ 分支均归入 improvement 桶', async () => {
    for (const p of ['ci/fix-workflow', 'build/bump-deps', 'chore/tidy']) {
      const b = blocksOf(await renderFullPr({ head: p }))
      expect(b.type).toContain(
        '- [x] Performance / technical improvement (perf, CI, build, chore, or other internal improvement)',
      )
    }
  })

  it('test/ 分支勾选 Tests，且 feature/pipeline-test-improves 不会误勾 Tests', async () => {
    const testBranch = await renderFullPr({ head: 'test/add-coverage' })
    expect(blocksOf(testBranch).type).toContain('- [x] Tests (adding or updating tests)')
    const falsePositive = await renderFullPr({ head: 'feature/pipeline-test-improves' })
    const fb = blocksOf(falsePositive).type
    expect(fb).not.toContain('- [x] Tests (adding or updating tests)')
    expect(fb).toContain('- [x] New feature (non-breaking change which adds functionality)')
  })

  it('refactor! 破坏性重构：同时勾 Refactor 与 Breaking change', async () => {
    const body = await renderFullPr({
      head: 'refactor/api',
      commits: '- refactor!: drop legacy renderer\n',
    })
    const b = blocksOf(body)
    expect(b.type).toContain(
      '- [x] Refactor (code change that neither fixes a bug nor adds a feature)',
    )
    expect(b.type).toContain(
      '- [x] Breaking change (fix or feature that would cause existing functionality to not work as expected)',
    )
  })

  it('无前缀杂项分支：安全默认勾选 Bug fix', async () => {
    const body = await renderFullPr({ head: 'misc', commits: 'wip' })
    const b = blocksOf(body)
    expect(b.type).toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
    expect(b.type).not.toContain(
      '- [x] Refactor (code change that neither fixes a bug nor adds a feature)',
    )
  })

  it('通过动态加载的真实 types.mjs 渲染（验证占位符与插件端到端对齐）', async () => {
    const registry = await realMarkflowRegistry()
    expect(typeof registry.types).toBe('function')
    const body = await renderFullPr({ head: 'feature/xyz' })
    const renderedTypes = await registry.types({
      head: 'feature/xyz',
      services: { git: { logSubjects: () => '', logRange: () => '' } },
    })
    expect(body).toContain(renderedTypes)
  })

  it('与完整渲染快照一致（结构稳定的回归护栏）', async () => {
    const body = await renderFullPr({
      head: 'feature/auto-pr-render',
      commits: '- a1 first\n- a2 second\n',
    })
    expect(body).toMatchSnapshot()
  })
})

// types 插件（从 fixture 动态加载，端到端）-----------------------------------
describe('types plugin (loaded from fixture, end-to-end)', () => {
  async function renderTypes(head, commits) {
    const registry = await realMarkflowRegistry()
    return registry.types({
      head,
      base: 'origin/main',
      services: { git: { logRange: () => commits, logSubjects: () => commits } },
    })
  }

  it('classifies from the branch prefix + commit subjects via ctx.services.git', async () => {
    expect(await renderTypes('feature/foo', '')).toContain('- [x] New feature')
    expect(await renderTypes('fix/foo', '')).toContain('- [x] Bug fix')
    expect(await renderTypes('refactor/foo', '')).toContain('- [x] Refactor')
    expect(await renderTypes('test/foo', '')).toContain('- [x] Tests')
    expect(await renderTypes('perf/foo', '')).toContain('- [x] Performance / technical improvement')
    expect(await renderTypes('ci/foo', '')).toContain('- [x] Performance / technical improvement')
    expect(await renderTypes('build/foo', '')).toContain(
      '- [x] Performance / technical improvement',
    )
    expect(await renderTypes('chore/foo', '')).toContain(
      '- [x] Performance / technical improvement',
    )
    expect(await renderTypes('docs/foo', '')).toContain('- [x] Documentation update')
  })

  it('ticks exactly one work-type box for a clean branch prefix', async () => {
    const out = await renderTypes('feature/foo', '')
    const checked = out.split('\n').filter((l) => l.startsWith('- [x]'))
    expect(checked).toHaveLength(1)
    expect(checked[0]).toContain('New feature')
  })

  it('ticks Breaking change from a "!" commit marker and overlays it on the work type', async () => {
    const out = await renderTypes('refactor/api', '- refactor!: drop legacy\n')
    expect(out).toContain('- [x] Refactor')
    expect(out).toContain('- [x] Breaking change')
  })

  it('defaults to Bug fix when nothing matches', async () => {
    const out = await renderTypes('misc', 'wip')
    expect(out).toContain('- [x] Bug fix')
    expect(out).not.toContain('- [x] Refactor')
  })

  it('is resilient: falls back to head-based classification when no git service is provided (no crash)', async () => {
    const registry = await realMarkflowRegistry()
    const out = await registry.types({ head: 'feature/foo' })
    // Even without a git service, the branch prefix drives the classification.
    expect(out).toContain('- [x] New feature')
    expect(out).not.toContain('[object Promise]')
  })

  it('is resilient: treats a throwing git as "no commits" and still classifies from the branch', async () => {
    const registry = await realMarkflowRegistry()
    const out = await registry.types({
      head: 'fix/foo',
      services: {
        git: {
          logSubjects: () => {
            throw new Error('boom')
          },
        },
      },
    })
    expect(out).toContain('- [x] Bug fix')
    expect(out).not.toContain('[object Promise]')
  })
})

// --- buildCtx -----------------------------------------------------------
describe('buildCtx', () => {
  it('assembles head/base/title/services and injects the git service', () => {
    const git = { logSubjects: () => '' }
    const ctx = buildCtx('feature/x', 'origin/main', 'X', { git })
    expect(ctx.head).toBe('feature/x')
    expect(ctx.base).toBe('origin/main')
    expect(ctx.title).toBe('X')
    expect(ctx.services.git).toBe(git)
  })

  it('does NOT pre-compute domain facts (typeFlags / fixes) — plugins own those', () => {
    const ctx = buildCtx('fix/#42-login', 'origin/main', 'Login', {
      git: { logSubjects: () => '- fix: resolve #42 crash\n' },
    })
    // The core stays ignorant of PR type / linked issue; those are derived by the
    // `types` / `issue` plugins from ctx.services.git.
    expect(ctx).not.toHaveProperty('typeFlags')
    expect(ctx).not.toHaveProperty('fixes')
    expect(ctx.head).toBe('fix/#42-login')
  })

  it('returns an empty services object when none is provided', () => {
    const ctx = buildCtx('feature/x', 'origin/main', 'X', undefined)
    expect(ctx.services).toEqual({})
    expect(ctx).not.toHaveProperty('typeFlags')
    expect(ctx).not.toHaveProperty('fixes')
  })
})
