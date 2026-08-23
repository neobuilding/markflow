// Unit tests for the GhService I/O boundary (gh-service.mjs).
//
// The default implementation shells out via execFileSync and injects the token
// into process.env.GH_TOKEN. We mock execFileSync to cover every branch
// (version probe, prList empty/parsed/bad-json, prCreate/prEdit/prListUrls, and
// the optional token injection) without a real `gh` binary or network.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createExecGhService } from './gh-service.mjs'

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('./exec-glue.mjs', () => ({ execFileSync }))

beforeEach(() => {
  execFileSync.mockReset()
  delete process.env.GH_TOKEN
})

describe('createExecGhService', () => {
  it('injects the token into process.env.GH_TOKEN when provided', () => {
    createExecGhService('secret-token')
    expect(process.env.GH_TOKEN).toBe('secret-token')
  })

  it('does not touch GH_TOKEN when no token is given', () => {
    createExecGhService(undefined)
    expect(process.env.GH_TOKEN).toBeUndefined()
  })

  it('version returns the trimmed version, or null when gh is missing', () => {
    const gh = createExecGhService('t')
    execFileSync.mockReturnValue('gh version 2.x\n')
    expect(gh.version()).toBe('gh version 2.x')
    execFileSync.mockImplementation(() => {
      throw new Error('command not found')
    })
    expect(gh.version()).toBeNull()
  })

  it('prList parses open PRs into an array', () => {
    execFileSync.mockReturnValue('[{"number":1,"url":"u","body":"b"}]')
    const list = createExecGhService('t').prList('feature/x', 'main')
    expect(list).toEqual([{ number: 1, url: 'u', body: 'b' }])
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--head',
        'feature/x',
        '--base',
        'main',
        '--state',
        'open',
        '--json',
        'number,url,body',
      ],
      expect.any(Object),
    )
  })

  it('prList returns [] when gh returns nothing (null out)', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('none')
    })
    expect(createExecGhService('t').prList('feature/x', 'main')).toEqual([])
  })

  it('prList returns [] when gh returns unparseable JSON', () => {
    execFileSync.mockReturnValue('not json')
    expect(createExecGhService('t').prList('feature/x', 'main')).toEqual([])
  })

  it('prCreate returns the created PR URL', () => {
    execFileSync.mockReturnValue('https://github.com/o/r/pull/2')
    const url = createExecGhService('t').prCreate('feature/x', 'main', 'T', 'B')
    expect(url).toBe('https://github.com/o/r/pull/2')
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'create', '--base', 'main', '--head', 'feature/x', '--title', 'T', '--body', 'B'],
      expect.any(Object),
    )
  })

  it('prEdit invokes gh pr edit without returning a value', () => {
    execFileSync.mockReturnValue('')
    const gh = createExecGhService('t')
    expect(gh.prEdit(7, 'new body')).toBeUndefined()
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'edit', '7', '--body', 'new body'],
      expect.any(Object),
    )
  })

  it('prListUrls returns the first url, or null when gh fails', () => {
    const gh = createExecGhService('t')
    execFileSync.mockReturnValue('https://github.com/o/r/pull/3')
    expect(gh.prListUrls('feature/x', 'main')).toBe('https://github.com/o/r/pull/3')
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--head',
        'feature/x',
        '--base',
        'main',
        '--state',
        'open',
        '--json',
        'url',
        '--jq',
        '.[0].url // empty',
      ],
      expect.any(Object),
    )
    execFileSync.mockImplementation(() => {
      throw new Error('none')
    })
    expect(gh.prListUrls('feature/x', 'main')).toBeNull()
  })
})
