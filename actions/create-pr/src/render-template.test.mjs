// Unit tests for the single rendering entry point (render-template.mjs).
//
// renderTemplate integrates read-template(string) + git service + registry +
// ctx + fillAutoBlocks + buildBody(refresh) behind ONE function. These tests
// exercise that integration against the repo's real template/git (the entry
// point intentionally owns its own I/O); we focus on the externally observable
// contract:
//   - it renders a body containing the derived title + commits block,
//   - it throws when `head` is missing,
//   - it falls back to a commits-only body when the template is empty,
//   - given an `existingBody`, it refreshes (merges) instead of returning fresh.
import { describe, it, expect } from 'vitest'
import { renderTemplate } from './render-template.mjs'

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
    const body = await renderTemplate({ head: 'feature/my-work', template: SAMPLE_TEMPLATE })
    // deriveTitle('feature/my-work') => 'My work'
    expect(body).toContain('# My work')
    expect(body).toContain('<!-- AUTO:commits -->')
  })

  it('throws when head is missing', async () => {
    await expect(renderTemplate({ template: SAMPLE_TEMPLATE })).rejects.toThrow(
      '`head` is required',
    )
  })

  it('falls back to a commits-only body when the template is empty', async () => {
    const body = await renderTemplate({ head: 'feature/x', template: '' })
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
})
