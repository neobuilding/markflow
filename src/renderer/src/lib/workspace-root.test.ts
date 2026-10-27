import { describe, it, expect } from 'vitest'
import { resolveWorkspaceRoot, commonAncestor } from './workspace-root'

describe('commonAncestor', () => {
  it('finds the shared directory', () => {
    expect(commonAncestor(['/ws/a', '/ws/b'])).toBe('/ws')
  })

  it('returns null for unrelated paths', () => {
    expect(commonAncestor(['/one/a', '/two/b'])).toBeNull()
  })

  it('refuses to fall all the way back to a drive root', () => {
    // `C:` is a technically-true but useless ancestor: opening it would watch an entire volume.
    expect(commonAncestor(['C:/a', 'C:/b'])).toBeNull()
  })

  it('accepts a single shared segment on POSIX', () => {
    expect(commonAncestor(['/a/x', '/a/y'])).toBe('/a')
  })

  it('separates segments on backslashes (Windows paths)', () => {
    expect(commonAncestor(['C:\\ws\\a', 'C:\\ws\\b'])).toBe('C:\\ws')
  })

  it('accepts relative (non-absolute) paths', () => {
    expect(commonAncestor(['ws/a', 'ws/b'])).toBe('ws')
  })

  it('returns null when any path has no segments', () => {
    // `/` splits to zero segments after filtering — there is nothing to anchor to.
    expect(commonAncestor(['/', '/a'])).toBeNull()
  })
})

describe('resolveWorkspaceRoot (ADR-0023)', () => {
  it('uses the only directory', () => {
    expect(resolveWorkspaceRoot(['/only'])).toEqual({
      ok: true,
      root: '/only',
      note: 'directory',
    })
  })

  it('falls back to the first file’s parent when no directory was resolved', () => {
    expect(resolveWorkspaceRoot([], '/files/a.md')).toMatchObject({
      ok: true,
      root: '/files',
      note: 'single-file',
    })
  })

  it('converges several directories on their common ancestor', () => {
    expect(resolveWorkspaceRoot(['/ws/a', '/ws/b'])).toMatchObject({
      ok: true,
      root: '/ws',
      note: 'common-ancestor',
    })
  })

  // The old code took `directories[0]` and silently ignored the rest — an arbitrary choice
  // presented as a decision (F21). Refusing is the honest behaviour.
  it('REFUSES unrelated directories instead of picking one', () => {
    const r = resolveWorkspaceRoot(['/one', '/two'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('multiple-roots')
    expect(r.candidates).toEqual(['/one', '/two'])
  })

  it('reports no-files when there is nothing at all', () => {
    expect(resolveWorkspaceRoot([], undefined)).toMatchObject({
      ok: false,
      reason: 'no-files',
    })
  })
})
