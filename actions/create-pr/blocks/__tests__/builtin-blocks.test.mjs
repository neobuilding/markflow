// Unit tests for the action's built-in block plugins (actions/create-pr/blocks/*).
//
// Each built-in plugin is a pure `ctx => string | Promise<string>`. These tests
// exercise the plugins in isolation and assert each one's own contract. The
// render-core engine that assembles and runs the registry is exercised separately
// by src/render.test.mjs; here we test the plugins themselves.
import { describe, it, expect } from 'vitest'
import titleBlock from '../title.mjs'
import issueBlock from '../issue.mjs'
import commitsBlock from '../commits.mjs'

// --- built-in block plugins (blocks/*) -----------------------------------
describe('built-in block plugins', () => {
  it('title: derives the title from the branch name', () => {
    expect(titleBlock({ head: 'feature/pipeline-test' })).toBe('Pipeline test')
  })

  it('title: yields an empty string for an empty head (no crash)', () => {
    expect(titleBlock({ head: '' })).toBe('')
  })

  it('title: returns ctx.title verbatim when provided (override path)', () => {
    expect(titleBlock({ title: 'Custom Title', head: 'feature/x' })).toBe('Custom Title')
  })

  it('title: returns an empty string when ctx.title is the empty string', () => {
    expect(titleBlock({ title: '', head: 'feature/x' })).toBe('')
  })

  it('issue: extracts the linked issue from the branch name (#prefix)', async () => {
    expect(await issueBlock({ head: 'fix/#42-login' })).toBe('42')
  })

  it('issue: extracts the linked issue from the commit subjects via the git service', async () => {
    expect(
      await issueBlock({
        head: 'feature/x',
        services: { git: { logSubjects: () => 'fix #7 thing' } },
      }),
    ).toBe('7')
  })

  it('issue: returns N/A when no issue is linked (empty-value policy lives in the plugin)', async () => {
    expect(await issueBlock({ head: 'feature/x' })).toBe('N/A')
  })

  it('issue: returns N/A when the git service throws (resilient, never aborts render)', async () => {
    expect(
      await issueBlock({
        head: 'feature/x',
        services: {
          git: {
            logSubjects: () => {
              throw new Error('boom')
            },
          },
        },
      }),
    ).toBe('N/A')
  })

  it('issue: tolerates a missing ctx without throwing (resilient)', async () => {
    expect(await issueBlock(undefined)).toBe('N/A')
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

  it('commits: tolerates a missing ctx without throwing (resilient)', () => {
    expect(commitsBlock(undefined)).toBe('')
  })
})
