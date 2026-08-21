// Unit tests for actions/create-pr/src/core.mjs pure logic.
//
// The module is imported only for its exported helpers; the side-effecting
// `runMain` is never called by these tests. Importing is safe because core.mjs
// no longer runs anything on import (the previous CLI direct-invocation guard
// was dropped when it became a library used by index.mjs).
//
// Block-plugin loading (`loadBlocks`) lives in loader.mjs (file IO + dynamic
// import) and is exercised by its own loader.test.mjs; it is intentionally NOT
// part of the core coverage gate.
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
  buildBodyFor,
  markersFor,
  renderBlock,
  discoverSegments,
} from './core.mjs'
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

// Markflow's `types` plugin, inlined here so core tests can render the real
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
    // No hand-written checklist lines remain inside the type block — the
    // `types` plugin generates them so they are not duplicated.
    expect(tpl).not.toContain('- [ ] Bug fix (non-breaking change which fixes an issue)')
  })
})

// --- deriveTitle ---------------------------------------------------------
describe('deriveTitle', () => {
  it('strips a feature/ prefix and title-cases the first letter', () => {
    expect(deriveTitle('feature/pipeline-test-improves')).toBe('Pipeline test improves')
  })

  it('handles fix/ and other conventional prefixes case-insensitively', () => {
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
describe('buildCommitsSection', () => {
  it('returns the commit list without a "## Commits" heading (heading is static in the template)', () => {
    const fakeLog = () => '- abc1234 add auto pr script\n- def5678 wire up workflow\n'
    const out = buildCommitsSection('feature/x', 'origin/main', fakeLog)
    expect(out).not.toContain('## Commits')
    expect(out).toContain('- abc1234 add auto pr script')
    expect(out).toContain('- def5678 wire up workflow')
  })

  it('returns an empty string when git log yields nothing', () => {
    expect(buildCommitsSection('feature/x', 'origin/main', () => '')).toBe('')
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

  it('commits: renders ctx.commits when provided by the caller', () => {
    expect(commitsBlock({ head: 'feature/x', commits: '- abc1234 did a thing\n' })).toContain(
      '- abc1234 did a thing',
    )
  })

  it('commits: falls back to buildCommitsSection (gitLogFn injectable) when ctx.commits is undefined', () => {
    const fakeLog = () => '- abc1234 did a thing\n'
    const out = commitsBlock({ head: 'feature/x', base: 'origin/main', gitLogFn: fakeLog })
    expect(out).toContain('- abc1234 did a thing')
  })

  it('commits: uses empty head / default base fallbacks when ctx.head/base are absent', () => {
    const fakeLog = (h, b) => `- log for ${b}`
    const out = commitsBlock({ gitLogFn: fakeLog })
    expect(out).toContain('- log for main')
  })

  it('commits: falls back to the real `git` CLI when no gitLogFn is provided', () => {
    // No gitLogFn => the built-in default runs `execFileSync('git', ...)`.
    // In a git checkout this returns the real commit list (a string).
    const out = commitsBlock({ head: 'feature/auto-pr', base: 'origin/main' })
    expect(typeof out).toBe('string')
  })

  it('commits: returns an empty string when the git log throws', () => {
    const out = commitsBlock({
      head: 'x',
      gitLogFn: () => {
        throw new Error('boom')
      },
    })
    expect(out).toBe('')
  })

  it('commits: returns an empty string when the git log yields nothing', () => {
    const out = commitsBlock({ head: 'x', gitLogFn: () => '' })
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
        commits: '- abc1234 did a thing\n',
        gitLogFn: () => '- abc1234 did a thing\n',
      },
      markflowRegistry(),
    )
    expect(blockContent(out, 'title')).toBe('# My PR')
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\n42')
    expect(blockContent(out, 'commits')).toContain('## Commits')
    expect(blockContent(out, 'commits')).toContain('- abc1234 did a thing')
    // The `types` plugin (not hard-coded text) produced the checkbox line.
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
        commits: '',
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
        commits: '',
      },
      markflowRegistry(),
    )
    // Description is outside the blocks -> preserved as a region.
    expect(out).toContain('## Description')
    // Checklist is an auto block with no {{placeholder}} -> reset to template state.
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
        commits: '',
      },
      markflowRegistry(),
    )
    // blockContent trims, so the rendered "# " (title || '') collapses to "#".
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
      commits: '- a1 add\n',
    })
    expect(buildBody(filled, '')).toBe(filled)
  })

  it('refreshes each auto block but preserves human text outside the blocks', () => {
    const filled = fill({
      title: 'Fresh Title',
      fixes: '99',
      typeFlags: { bug: false, feature: true, breaking: false, docs: false },
      commits: '- a1 add\n',
    })
    // Build a realistic existing body: take the template, fill with STALE values,
    // and inject human notes outside the blocks.
    const stale = fillAutoBlocks(
      tpl,
      {
        head: 'feature/auto-pr',
        base: 'origin/main',
        title: 'Stale Title',
        fixes: '1',
        typeFlags: { bug: true, feature: false, breaking: false, docs: false },
        commits: '- old commit\n',
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
    // Human-written Description survives; Checklist is reset to template state.
    expect(out).toContain('## Description')
    expect(blockContent(out, 'checklist')).toContain('## Checklist')
    expect(blockContent(out, 'checklist')).toContain('- [ ] My code follows the style guidelines')
  })

  it('A2: prepends filled template and keeps the whole legacy body when no blocks exist', () => {
    const filled = fill({
      title: 'Auto pr',
      fixes: '',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      commits: '- a1 add\n',
    })
    const legacy = '## Checklist\n\n- [x] reviewed\n\nSome human context here'
    const out = buildBody(filled, legacy)
    expect(out.startsWith('<!-- AUTO:title -->')).toBe(true)
    expect(out).toContain('- [x] reviewed')
    expect(out).toContain('Some human context here')
  })

  it('refreshes a CUSTOM auto block key (not in any hard-coded list) on update', () => {
    // A repo that added its own block (e.g. `<!-- AUTO:security -->`) must be
    // refreshed like any built-in block, because block keys are discovered
    // dynamically — there is no fixed key list to keep in sync.
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
      commits: '- a1 add\n',
    })
    // Simulate a fresh template missing the 'commits' block.
    const filledNoCommits = filled.replace(
      /<!-- AUTO:commits -->[\s\S]*?<!-- \/AUTO:commits -->/,
      '',
    )
    const existingBody = `human above\n\n${filled}\n\nhuman below`
    const out = buildBody(filledNoCommits, existingBody)
    // The commits block is absent from the fresh template, so the existing one
    // (from the original filled body) is preserved.
    expect(out).toContain('- a1 add')
  })
})

// --- buildBodyFor -------------------------------------------------------
describe('buildBodyFor', () => {
  it('builds a first-creation body from the template (no existing body)', () => {
    const out = buildBodyFor(
      'feature/auto-pr',
      'origin/main',
      '',
      '.github/pull-request-template.md',
      markflowRegistry(),
    )
    expect(out).toContain('# Auto pr')
    expect(out).toContain('<!-- AUTO:title -->')
    expect(out).toContain('<!-- /AUTO:title -->')
    expect(out).toContain('## Checklist')
    // The types block is rendered by the plugin, not hard-coded.
    expect(out).toContain('- [ ] My code follows the style guidelines')
    // head is feature/auto-pr => the `feature` box is ticked, `bug` is not.
    expect(out).toContain('- [x] New feature (non-breaking change which adds functionality)')
    expect(out).not.toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
  })

  it('refreshes only the auto blocks when an existing partitioned body is given', () => {
    const existing =
      `human above\n\n${readFileSync('.github/pull-request-template.md', 'utf8')
        .replace('{{title}}', 'Stale')
        .replace('{{issue}}', '1')
        .replace('{{commits}}', '- old commit\n')
        .replace('{{types}}', '- [ ] Bug fix (non-breaking change which fixes an issue)')}\n\n` +
      `human below`
    const out = buildBodyFor(
      'feature/auto-pr',
      'origin/main',
      existing,
      '.github/pull-request-template.md',
      markflowRegistry(),
    )
    expect(out).toContain('human above')
    expect(out).toContain('human below')
    expect(out).toContain('# Auto pr')
    expect(out).not.toContain('# Stale')
  })
})
