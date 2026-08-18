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
  fillTemplate,
  buildBody,
  extractAutoSection,
} from './create-pr.mjs'

// Guard against a duplicated END marker silently shrinking the auto section.
describe('PR template integrity', () => {
  const tpl = readFileSync('.github/pull-request-template.md', 'utf8')

  it('has exactly one START and one END marker', () => {
    expect(tpl.match(/<!-- AUTO-GENERATED-START -->/g) || []).toHaveLength(1)
    expect(tpl.match(/<!-- AUTO-GENERATED-END -->/g) || []).toHaveLength(1)
  })

  it('the auto section spans the whole template (Checklist included)', () => {
    const section = extractAutoSection(tpl)
    expect(section).not.toBe(null)
    expect(section).toContain('## Checklist')
    expect(section).toContain('- [ ] My code follows the style guidelines')
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
  it('wraps git-log output in a "## Commits" markdown list', () => {
    const fakeLog = () => '- abc1234 add auto pr script\n- def5678 wire up workflow\n'
    const out = buildCommitsSection('feature/x', 'origin/main', fakeLog)
    expect(out).toContain('## Commits')
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

// --- extractAutoSection --------------------------------------------------
describe('extractAutoSection', () => {
  const START = '<!-- AUTO-GENERATED-START -->'
  const END = '<!-- AUTO-GENERATED-END -->'

  it('returns the text between the markers inclusive', () => {
    const body = `${START}\n# Title\n\n## Description\n\n- x\n${END}\n\n## Checklist`
    expect(extractAutoSection(body)).toBe(`${START}\n# Title\n\n## Description\n\n- x\n${END}`)
  })

  it('returns null when either marker is absent', () => {
    expect(extractAutoSection('# Title\nno markers')).toBe(null)
    expect(extractAutoSection(`${START}\nonly start`)).toBe(null)
  })
})

// --- fillTemplate --------------------------------------------------------
describe('fillTemplate', () => {
  const auto = `<!-- AUTO-GENERATED-START -->
# {{title}}

## Description

{{description}}

Fixes #(issue number):
{{issue}}

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## How Has This Been Tested?

{{tested}}

## Checklist

- [ ] My code follows the style guidelines of this project
- [ ] I have added tests that prove my fix is effective or that my feature works

<!-- AUTO-GENERATED-END -->`

  it('fills title, description, issue and tested placeholders', () => {
    const out = fillTemplate(auto, {
      title: 'My PR',
      description: '- did a thing\n',
      fixes: '42',
      tested: 'ran tests',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
    })
    expect(out).toContain('# My PR')
    expect(out).toContain('- did a thing')
    expect(out).toContain('Fixes #(issue number):')
    expect(out).toContain('42')
    expect(out).toContain('ran tests')
  })

  it('ticks the Bug fix box and leaves others unticked', () => {
    const out = fillTemplate(auto, {
      title: 'T',
      description: '',
      fixes: '',
      tested: 't',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
    })
    expect(out).toContain('- [x] Bug fix (non-breaking change which fixes an issue)')
    expect(out).toContain('- [ ] New feature (non-breaking change which adds functionality)')
  })

  it('shows "--" as the issue value when none is referenced', () => {
    const out = fillTemplate(auto, {
      title: 'T',
      description: '',
      fixes: '',
      tested: 't',
      typeFlags: { bug: true, feature: false, breaking: false, docs: false },
    })
    expect(out).not.toContain('{{issue}}')
    expect(out).toContain('Fixes #(issue number):')
    expect(out).toContain('--')
  })
})

// --- buildBody -----------------------------------------------------------
describe('buildBody', () => {
  const START = '<!-- AUTO-GENERATED-START -->'
  const END = '<!-- AUTO-GENERATED-END -->'

  it('returns the auto section alone on first creation (no existing body)', () => {
    const auto = `${START}\n# Title\n\n## Description\n\n- x\n${END}`
    expect(buildBody(auto, '')).toBe(auto)
  })

  it('replaces only the marked section, preserving human content outside', () => {
    const auto = `${START}\n# New Title\n\n## Description\n\n- y\n${END}`
    const existing =
      `human note above\n\n${START}\n# Old Title\n\n## Description\n\n- x\n${END}\n\n` +
      `human note below END`
    const out = buildBody(auto, existing)
    expect(out).toContain('human note above')
    expect(out).toContain('# New Title')
    expect(out).toContain('- y')
    expect(out).toContain(`${END}`)
    expect(out).toContain('human note below END')
    expect(out).not.toContain('# Old Title')
    expect(out).not.toContain('- x')
  })

  it('A2: prepends auto section and keeps the whole legacy body when unpartitioned', () => {
    const auto = `${START}\n# Title\n\n## Description\n\n- x\n${END}`
    const legacy = '## Checklist\n\n- [x] reviewed\n\nSome human context here'
    const out = buildBody(auto, legacy)
    expect(out.startsWith(`${START}`)).toBe(true)
    expect(out).toContain('- x')
    expect(out).toContain('- [x] reviewed')
    expect(out).toContain('Some human context here')
  })
})
