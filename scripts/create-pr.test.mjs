// Unit tests for scripts/create-pr.mjs pure logic.
//
// The script's side-effecting entry point (runMain) is NOT executed on import:
// it is guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`,
// and under vitest `process.argv[1]` is the test runner, not this script. So
// importing the module is safe and only the exported helpers are exercised.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  deriveTitle,
  buildCommitsSection,
  buildDescription,
  classifyChange,
  extractFixes,
  fillAutoBlocks,
  fillPlaceholderBlock,
  replaceAutoBlock,
  blockContent,
  tickTypeBoxes,
  buildBody,
  buildBodyFor,
  markersFor,
} from './create-pr.mjs'

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

describe('fillPlaceholderBlock', () => {
  it('replaces the {{placeholder}} and preserves other content inside the block', () => {
    const template = '<!-- AUTO:title -->\n# {{title}}\n> subtitle line\n<!-- /AUTO:title -->'
    const out = fillPlaceholderBlock(template, template, 'title', 'title', 'My Title')
    expect(blockContent(out, 'title')).toBe('# My Title\n> subtitle line')
  })

  it('replaces every occurrence of the placeholder (global)', () => {
    const template = '<!-- AUTO:x -->\n{{v}} and {{v}}\n<!-- /AUTO:x -->'
    const out = fillPlaceholderBlock(template, template, 'x', 'v', 'VAL')
    expect(blockContent(out, 'x')).toBe('VAL and VAL')
  })

  it('falls back to fallback when value is empty', () => {
    const template = '<!-- AUTO:issue -->\n## Fixes #(n)\n\n{{issue}}\n<!-- /AUTO:issue -->'
    const out = fillPlaceholderBlock(template, template, 'issue', 'issue', '', 'N/A')
    expect(blockContent(out, 'issue')).toBe('## Fixes #(n)\n\nN/A')
  })

  it('is a no-op (never drops human text) when the block is absent from the body', () => {
    const body = 'human paragraph outside blocks'
    const template = '<!-- AUTO:title -->\n# {{title}}\n<!-- /AUTO:title -->'
    expect(fillPlaceholderBlock(body, template, 'title', 'title', 'X')).toBe(body)
  })

  it('covers the null block fallback when the block is absent from the template', () => {
    const body = 'human paragraph'
    const template = 'no auto blocks here'
    expect(fillPlaceholderBlock(body, template, 'title', 'title', 'X')).toBe(body)
  })
})

// --- tickTypeBoxes -------------------------------------------------------
describe('tickTypeBoxes', () => {
  const block = `## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update`

  it('ticks the Bug fix box and leaves others unticked', () => {
    const out = tickTypeBoxes(block, {
      bug: true,
      feature: false,
      breaking: false,
      docs: false,
    })
    expect(out).toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
    expect(out).toContain('- [ ] New feature (non-breaking change which adds functionality)')
  })

  it('ticks the Documentation box when docs flag is set', () => {
    const out = tickTypeBoxes(block, {
      bug: false,
      feature: false,
      breaking: false,
      docs: true,
    })
    expect(out).toContain('- [x] Documentation update')
  })

  it('ticks New feature and Breaking change together', () => {
    const out = tickTypeBoxes(block, {
      bug: false,
      feature: true,
      breaking: true,
      docs: false,
    })
    expect(out).toContain('- [x] New feature (non-breaking change which adds functionality)')
    expect(out).toContain(
      '- [x] Breaking change (fix or feature that would cause existing functionality to not work as expected)',
    )
  })
})

// --- fillAutoBlocks ------------------------------------------------------
describe('fillAutoBlocks', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  it('fills title, issue, commits and ticks the type block from ctx', () => {
    const out = fillAutoBlocks(tpl, {
      title: 'My PR',
      fixes: '42',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      commits: '- abc1234 did a thing\n',
    })
    expect(blockContent(out, 'title')).toBe('# My PR')
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\n42')
    expect(blockContent(out, 'commits')).toContain('## Commits')
    expect(blockContent(out, 'commits')).toContain('- abc1234 did a thing')
    expect(blockContent(out, 'type')).toContain(
      '- [x] Bug fix (non-breaking change which fixes an issue)',
    )
  })

  it('shows "N/A" as the issue value when none is referenced', () => {
    const out = fillAutoBlocks(tpl, {
      title: 'T',
      fixes: '',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      commits: '',
    })
    expect(blockContent(out, 'issue')).toBe('## Fixes #(issue number)\n\nN/A')
  })

  it('preserves the human Description region but resets the Checklist block to template state', () => {
    const out = fillAutoBlocks(tpl, {
      title: 'T',
      fixes: '',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      commits: '',
    })
    // Description is outside the blocks -> preserved as a region.
    expect(out).toContain('## Description')
    // Checklist is an auto block -> present (reset to template, all unticked).
    expect(blockContent(out, 'checklist')).toContain('## Checklist')
    expect(blockContent(out, 'checklist')).toContain('- [ ] My code follows the style guidelines')
  })

  it('renders an empty title block when no title is provided', () => {
    const out = fillAutoBlocks(tpl, {
      title: '',
      fixes: '',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      commits: '',
    })
    // blockContent trims, so the rendered "# " (title || '') collapses to "#".
    expect(blockContent(out, 'title')).toBe('#')
  })
})

// --- buildBody -----------------------------------------------------------
describe('buildBody', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  function fill(ctx) {
    return fillAutoBlocks(tpl, ctx)
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
    const stale = fillAutoBlocks(tpl, {
      title: 'Stale Title',
      fixes: '1',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
      commits: '- old commit\n',
    })
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
    const out = buildBodyFor('feature/auto-pr', 'origin/main', '')
    expect(out).toContain('# Auto pr')
    expect(out).toContain('<!-- AUTO:title -->')
    expect(out).toContain('<!-- /AUTO:title -->')
    expect(out).toContain('## Checklist')
  })

  it('refreshes only the auto blocks when an existing partitioned body is given', () => {
    const existing =
      `human above\n\n${readFileSync('.github/pull-request-template.md', 'utf8')
        .replace('{{title}}', 'Stale')
        .replace('{{issue}}', '1')
        .replace('{{commits}}', '- old commit\n')}\n\n` + `human below`
    const out = buildBodyFor('feature/auto-pr', 'origin/main', existing)
    expect(out).toContain('human above')
    expect(out).toContain('human below')
    expect(out).toContain('# Auto pr')
    expect(out).not.toContain('# Stale')
  })
})
