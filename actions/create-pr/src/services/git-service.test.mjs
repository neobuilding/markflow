// Unit tests for the GitService I/O boundary (git-service.mjs).
//
// The default implementation shells out via execFileSync; we mock that single
// call so every branch (success, null-on-failure via tryRun, the hasOrigin
// split/includes, and the head-param-ignored log methods) is exercised without
// a real git repo. Keeping the surface 100% covered matters because the renderer
// and orchestration depend on these methods.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createExecGitService } from './git-service.mjs'

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('./exec-glue.mjs', () => ({ execFileSync }))

beforeEach(() => {
  execFileSync.mockReset()
})

describe('createExecGitService', () => {
  it('hasOrigin reports true when `origin` is among remotes', () => {
    execFileSync.mockReturnValue('origin\nupstream\n')
    const git = createExecGitService()
    expect(git.hasOrigin()).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('git', ['remote'], expect.any(Object))
  })

  it('hasOrigin reports false when there is no origin', () => {
    execFileSync.mockReturnValue('upstream\n')
    expect(createExecGitService().hasOrigin()).toBe(false)
  })

  it('fetchBase returns the trimmed output on success', () => {
    execFileSync.mockReturnValue('')
    const git = createExecGitService()
    expect(git.fetchBase('main')).toBe('')
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', 'main', '--quiet'],
      expect.any(Object),
    )
  })

  it('fetchBase returns null when the fetch fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('exit 1')
    })
    expect(createExecGitService().fetchBase('main')).toBeNull()
  })

  it('revParse returns the resolved ref, or null when missing', () => {
    const git = createExecGitService()
    execFileSync.mockReturnValue('abc123\n')
    expect(git.revParse('origin/main')).toBe('abc123')
    execFileSync.mockImplementation(() => {
      throw new Error('unknown rev')
    })
    expect(git.revParse('origin/main')).toBeNull()
  })

  it('logRange and logSubjects call git log with the base..HEAD range and ignore head', () => {
    const git = createExecGitService()
    execFileSync.mockReturnValue('- deadbeef subject')
    expect(git.logRange('feature/x', 'main')).toBe('- deadbeef subject')
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--no-merges', '--pretty=format:- %h %s', 'main..HEAD'],
      expect.any(Object),
    )
    expect(git.logSubjects('feature/x', 'main')).toBe('- deadbeef subject')
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['log', '--no-merges', '--pretty=format:- %s', 'main..HEAD'],
      expect.any(Object),
    )
  })

  it('logRange returns null when the log fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('no history')
    })
    expect(createExecGitService().logRange('feature/x', 'main')).toBeNull()
  })

  it('lsRemote returns the remote ref, or null on failure', () => {
    const git = createExecGitService()
    execFileSync.mockReturnValue('abc123\trefs/heads/feature/x')
    expect(git.lsRemote('feature/x')).toBe('abc123\trefs/heads/feature/x')
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--heads', 'origin', 'feature/x'],
      expect.any(Object),
    )
    execFileSync.mockImplementation(() => {
      throw new Error('no remote')
    })
    expect(git.lsRemote('feature/x')).toBeNull()
  })
})
