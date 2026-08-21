// Unit tests for actions/create-pr/src/render.mjs pure logic.
//
// render.mjs is 100% pure (zero I/O, zero @actions/core, zero execFileSync).
// The block-plugin loading (loadBlocks) lives in loader.mjs (file IO + dynamic
// import) and is exercised by loader.test.mjs; the orchestration flow
// (createOrRefreshPr) is exercised by orchestration.test.mjs with fake services.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  deriveTitle,
  buildCommitsSection,
  buildDescription,
  classifyChange,
  extractFixes,
  fillAutoBlocks,
  replaceAutoBlock,
  blockContent,
  buildBody,
  markersFor,
  renderBlock,
  discoverSegments,
  buildCtx,
} from './render.mjs'
import titleBlock from './blocks/title.mjs'
import issueBlock from './blocks/issue.mjs'
import commitsBlock from './blocks/commits.mjs'

// A registry mirroring the action's built-in blocks, used by tests that render
// the real template (the same plugins shipped in src/blocks/). Plugin names
// match the template's placeholders: `title` / `issue` / `commits`.
function builtinRegistry() {
  return {
    title: titleBlock,
    issue: issueBlock,
    commits: commitsBlock,
  }
}

// Markflow's `types` plugin, inlined here so render tests can render the real
// template's `{{types}}` placeholder without depending on the repo-side file.
const typesBlock = (ctx) => {
  const flags = (ctx && ctx.typeFlags) || {}
  const row = (label, on) => `- [${on ? 'x' : ' '}] ${label}`
  return [
    row('Bug fix (non-breaking change which fixes an issue)', flags.bug),
    row('New feature (non-breaking change which adds functionality)', flags.feature),
    row(
      'Breaking change (fix or feature that would cause existing functionality to not work as expected)',
      flags.breaking,
    ),
    row('Documentation update', flags.docs),
  ].join('\n')
}

// The full registry markflow uses: built-in blocks + the repo's `types` plugin.
function markflowRegistry() {
  return { ...builtinRegistry(), types: typesBlock }
}

// Guard against a duplicated / malformed block marker silently shrinking a block.
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
// render.mjs buildCommitsSection NEVER calls git on its own — it returns '' when
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

// --- classifyChange ------------------------------------------------------
describe('classifyChange', () => {
  it('ticks Bug fix for a fix/ branch', () => {
    expect(classifyChange('fix/login', 'fix: handle null')).toEqual({
      bug: true,
      feature: false,
      breaking: false,
      docs: false,
    })
  })

  it('ticks New feature for a feature/ branch', () => {
    const f = classifyChange('feature/foo', 'feat: add x')
    expect(f.feature).toBe(true)
    expect(f.bug).toBe(false)
  })

  it('ticks Breaking change when commit mentions breaking', () => {
    const f = classifyChange('feature/foo', 'feat!: breaking change')
    expect(f.breaking).toBe(true)
  })

  it('ticks Documentation for a docs/ branch', () => {
    expect(classifyChange('docs/readme', 'docs: update').docs).toBe(true)
  })

  it('defaults to Bug fix when nothing matches', () => {
    expect(classifyChange('misc', 'chore: tidy').bug).toBe(true)
  })
})

// --- extractFixes --------------------------------------------------------
describe('extractFixes', () => {
  it('extracts the first issue number', () => {
    expect(extractFixes('feature/foo', 'fix: resolve #42 crash')).toBe('42')
  })

  it('also reads issue numbers from the branch name when prefixed with #', () => {
    expect(extractFixes('fix/#123-login', 'tweak things')).toBe('123')
  })

  it('returns empty string when no issue is referenced', () => {
    expect(extractFixes('feature/foo', 'add stuff')).toBe('')
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
  it('renders a registered block plugin, passing ctx', () => {
    const reg = { greet: (ctx) => `hi ${ctx.name}` }
    expect(renderBlock('greet', { name: 'x' }, reg)).toBe('hi x')
  })

  it('returns the {{name}} placeholder untouched when no plugin is registered', () => {
    expect(renderBlock('missing', {}, {})).toBe('{{missing}}')
    expect(renderBlock('missing', {}, undefined)).toBe('{{missing}}')
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

// --- built-in block plugins (src/blocks/*) -------------------------------
describe('built-in block plugins', () => {
  it('title: derives the title from the branch name', () => {
    expect(titleBlock({ head: 'feature/pipeline-test' })).toBe('Pipeline test')
  })

  it('title: yields an empty string for an empty head (no crash)', () => {
    expect(titleBlock({ head: '' })).toBe('')
  })

  it('issue: returns the linked issue number', () => {
    expect(issueBlock({ fixes: '42' })).toBe('42')
  })

  it('issue: returns N/A when no issue is linked (empty-value policy lives in the plugin)', () => {
    expect(issueBlock({ fixes: '' })).toBe('N/A')
  })

  // The `commits` plugin is autonomous: it pulls the list from
  // `ctx.services.git.logRange`, so tests provide a fake git service.
  const fakeGit = (logRange) => ({ logRange })

  it('commits: pulls the commit list from ctx.services.git.logRange', () => {
    const out = commitsBlock({
      head: 'feature/x',
      base: 'origin/main',
      services: { git: fakeGit(() => '- abc1234 did a thing\n- def5678 more\n') },
    })
    expect(out).toContain('- abc1234 did a thing')
    expect(out).toContain('- def5678 more')
  })

  it('commits: uses empty head / default base fallbacks when ctx.head/base are absent', () => {
    const out = commitsBlock({
      services: { git: fakeGit((h, b) => `- log for ${b}`) },
    })
    expect(out).toContain('- log for main')
  })

  it('commits: returns an empty string when no git service is provided', () => {
    expect(commitsBlock({ head: 'x' })).toBe('')
    expect(commitsBlock({ head: 'x', services: {} })).toBe('')
  })

  it('commits: returns an empty string when the git log throws', () => {
    const out = commitsBlock({
      head: 'x',
      services: {
        git: fakeGit(() => {
          throw new Error('boom')
        }),
      },
    })
    expect(out).toBe('')
  })

  it('commits: returns an empty string when the git log yields nothing', () => {
    const out = commitsBlock({
      head: 'x',
      services: { git: fakeGit(() => '') },
    })
    expect(out).toBe('')
  })
})

// --- fillAutoBlocks ------------------------------------------------------
describe('fillAutoBlocks', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  it('fills title, issue, commits and renders the types block via the registry', () => {
    const out = fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'My PR',
        fixes: '42',
        typeFlags: { bug: true, feature: false, breaking: false, docs: false },
        services: { git: { logRange: () => '- abc1234 did a thing\n' } },
      },
      markflowRegistry(),
    )
    expect(blockContent(out, 'title')).toBe('# My PR')
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\n42')
    expect(blockContent(out, 'commits')).toContain('## Commits')
    expect(blockContent(out, 'commits')).toContain('- abc1234 did a thing')
    expect(blockContent(out, 'type')).toContain(
      '- [x] Bug fix (non-breaking change which fixes an issue)',
    )
  })

  it('shows "N/A" as the issue value when none is referenced (issues plugin policy)', () => {
    const out = fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'T',
        fixes: '',
        typeFlags: { bug: true, feature: false, breaking: false, docs: false },
        services: { git: { logRange: () => '' } },
      },
      markflowRegistry(),
    )
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\nN/A')
  })

  it('preserves the human Description region but resets the Checklist block to template state', () => {
    const out = fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'T',
        fixes: '',
        typeFlags: { bug: true, feature: false, breaking: false, docs: false },
        services: { git: { logRange: () => '' } },
      },
      markflowRegistry(),
    )
    expect(out).toContain('## Description')
    expect(blockContent(out, 'checklist')).toContain('## Checklist')
    expect(blockContent(out, 'checklist')).toContain('- [ ] My code follows the style guidelines')
  })

  it('renders an empty title block when no title is provided', () => {
    const out = fillAutoBlocks(
      tpl,
      {
        head: '',
        base: 'origin/main',
        title: '',
        fixes: '',
        typeFlags: { bug: true, feature: false, breaking: false, docs: false },
        services: { git: { logRange: () => '' } },
      },
      markflowRegistry(),
    )
    expect(blockContent(out, 'title')).toBe('#')
  })

  it('leaves {{name}} untouched when no plugin is registered for it', () => {
    const localTpl = '<!-- AUTO:custom -->\n## Custom\n\n{{custom}}\n<!-- /AUTO:custom -->'
    const out = fillAutoBlocks(localTpl, {}, {})
    expect(blockContent(out, 'custom')).toBe('## Custom\n\n{{custom}}')
  })

  it('renders every occurrence of a {{placeholder}} inside a block (global)', () => {
    const localTpl = '<!-- AUTO:x -->\n{{v}} and {{v}}\n<!-- /AUTO:x -->'
    const out = fillAutoBlocks(localTpl, {}, { v: () => 'VAL' })
    expect(blockContent(out, 'x')).toBe('VAL and VAL')
  })

  it('a template with no AUTO markers is used verbatim (no rendering)', () => {
    const plain = 'Just plain text.\nNo markers here.'
    expect(fillAutoBlocks(plain, { title: 'X' }, builtinRegistry())).toBe(plain)
  })
})

// --- buildBody -----------------------------------------------------------
describe('buildBody', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  function fill(ctx) {
    return fillAutoBlocks(
      tpl,
      { head: 'feature/auto-pr', base: 'origin/main', ...ctx },
      markflowRegistry(),
    )
  }

  it('returns the filled template alone on first creation (no existing body)', () => {
    const filled = fill({
      title: 'Auto pr',
      fixes: '7',
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
      services: { git: { logRange: () => '- a1 add\n' } },
    })
    expect(buildBody(filled, '')).toBe(filled)
  })

  it('refreshes each auto block but preserves human text outside the blocks', () => {
    const filled = fill({
      title: 'Fresh Title',
      fixes: '99',
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
      services: { git: { logRange: () => '- a1 add\n' } },
    })
    const stale = fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'Stale Title',
        fixes: '1',
        typeFlags: { bug: true, feature: false, breaking: false, docs: false },
        services: { git: { logRange: () => '- old commit\n' } },
      },
      markflowRegistry(),
    )
    const existingBody = `human note above\n\n${stale}\n\nhuman note below`
    const out = buildBody(filled, existingBody)
    expect(out).toContain('human note above')
    expect(out).toContain('human note below')
    expect(blockContent(out, 'title')).toBe('# Fresh Title')
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\n99')
    expect(blockContent(out, 'commits')).toContain('## Commits')
    expect(blockContent(out, 'commits')).toContain('- a1 add')
    expect(out).not.toContain('Stale Title')
    expect(out).not.toContain('- old commit')
    expect(out).toContain('## Description')
    expect(blockContent(out, 'checklist')).toContain('## Checklist')
    expect(blockContent(out, 'checklist')).toContain('- [ ] My code follows the style guidelines')
  })

  it('A2: prepends filled template and keeps the whole legacy body when no blocks exist', () => {
    const filled = fill({
      title: 'Auto pr',
      fixes: '',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      services: { git: { logRange: () => '- a1 add\n' } },
    })
    const legacy = '## Checklist\n\n- [x] reviewed\n\nSome human context here'
    const out = buildBody(filled, legacy)
    expect(out.startsWith('<!-- AUTO:title -->')).toBe(true)
    expect(out).toContain('- [x] reviewed')
    expect(out).toContain('Some human context here')
  })

  it('refreshes a CUSTOM auto block key (not in any hard-coded list) on update', () => {
    const customTpl =
      '<!-- AUTO:title -->\n# {{title}}\n<!-- /AUTO:title -->\n\n' +
      '<!-- AUTO:security -->\n## Security\n\n{{security}}\n<!-- /AUTO:security -->'
    const freshCtx = { title: 'Fresh', security: 'scanned' }
    const filled = fillAutoBlocks(customTpl, freshCtx, {
      title: (c) => c.title,
      security: (c) => c.security,
    })
    const stale = fillAutoBlocks(
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

  it('skips a block when it is absent from the fresh template (leaves existing block intact)', () => {
    const filled = fill({
      title: 'Auto pr',
      fixes: '',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      services: { git: { logRange: () => '- a1 add\n' } },
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

// --- 完整 PR 模板的本地渲染（端到端） -----------------------------------
//
// 这些用例演示如何在本地试验"对完整 PR 模板"的渲染效果，而不需要 GitHub/
// `gh`/真实 git 历史。核心思路：render.mjs 的纯函数 `fillAutoBlocks` 只依赖
//   1. PR 模板字符串
//   2. 块插件注册表 (registry)
//   3. 我们手动构造的 ctx（title/fixes/typeFlags/commits）
// 只要把 ctx 完全注入，渲染结果就是确定的、可复现的，与本地是否有 git 历史
// 无关。等价于 cli-render.mjs 做的事，只是用内联断言而非 console.log。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBlocks } from './loader.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TEMPLATE_PATH = join(REPO_ROOT, '.github', 'pull-request-template.md')
const TYPES_DIR = join(REPO_ROOT, '.github', 'create-pr', 'blocks')

// 直接用 loader 加载仓库里真实的 `types.mjs` 插件（与 action 运行时一致），
// 而不是依赖测试内联的副本 —— 这样端到端地验证"模板 {{types}} 占位符"和
// "仓库提供的插件"真的对得上，避免两者悄悄漂移。
async function realMarkflowRegistry() {
  const user = await loadBlocks(TYPES_DIR)
  return { ...builtinRegistry(), ...user }
}

// 渲染完整 PR body：完全本地、确定性。遵循插件自治原则——commits 由 commits
// 插件从 ctx.services.git 自取，这里只注入一个 fake git service 提供确定性的
// commit 列表，因此结果不依赖真实 git 历史。
async function renderFullPr({
  head,
  base = 'origin/main',
  title,
  fixes = '',
  typeFlags,
  commits = '',
}) {
  const registry = await realMarkflowRegistry()
  const tpl = readFileSync(TEMPLATE_PATH, 'utf8')
  const ctx = {
    head,
    base,
    title: title ?? deriveTitle(head),
    fixes,
    typeFlags: typeFlags ?? classifyChange(head, ''),
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
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
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
      fixes: '123',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
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
    const body = await renderFullPr({
      head: 'docs/update-readme',
      typeFlags: { bug: false, feature: false, breaking: false, docs: true },
    })
    const b = blocksOf(body)
    expect(b.type).toContain('- [x] Documentation update')
    expect(b.type).not.toContain('- [x] New feature (non-breaking change which adds functionality)')
    expect(b.type).not.toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
  })

  it('通过动态加载的真实 types.mjs 渲染（验证占位符与插件端到端对齐）', async () => {
    const registry = await realMarkflowRegistry()
    expect(typeof registry.types).toBe('function')
    const body = await renderFullPr({
      head: 'feature/xyz',
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
    })
    const renderedTypes = registry.types({
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
    })
    expect(body).toContain(renderedTypes)
  })

  it('与完整渲染快照一致（结构稳定的回归护栏）', async () => {
    const body = await renderFullPr({
      head: 'feature/auto-pr-render',
      fixes: '42',
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
      commits: '- a1 first\n- a2 second\n',
    })
    expect(body).toMatchSnapshot()
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

  it('derives fixes and typeFlags from the git logSubjects when a git service is provided', () => {
    const ctx = buildCtx('fix/#42-login', 'origin/main', 'Login', {
      git: { logSubjects: () => '- fix: resolve #42 crash\n' },
    })
    expect(ctx.fixes).toBe('42')
    expect(ctx.typeFlags.bug).toBe(true)
    expect(ctx.typeFlags.feature).toBe(false)
  })

  it('derives fixes and typeFlags from the branch name when no git service is provided', () => {
    const ctx = buildCtx('fix/#42-login', 'origin/main', 'Login', undefined)
    expect(ctx.fixes).toBe('42')
    expect(ctx.typeFlags.bug).toBe(true)
  })
})
