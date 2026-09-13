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

  it('retries prEdit and succeeds after a transient EOF', () => {
    // A bare `EOF` is Go's io.EOF — a transient GitHub-API connection drop that
    // surfaces when `gh` reads a response that was closed mid-stream. It must be
    // retried, not treated as a fatal edit failure.
    const gh = createExecGhService('t')
    let calls = 0
    execFileSync.mockImplementation(() => {
      calls += 1
      if (calls < 3) throw new Error('Command failed: gh pr edit 7 --body ...\nEOF')
      return ''
    })
    expect(gh.prEdit(7, 'new body')).toBeUndefined()
    expect(calls).toBe(3)
  })

  it('does not retry a non-transient gh error', () => {
    const gh = createExecGhService('t')
    let calls = 0
    execFileSync.mockImplementation(() => {
      calls += 1
      throw new Error('Command failed: gh pr edit 7 --body ...\nHTTP 422: Validation Failed')
    })
    expect(() => gh.prEdit(7, 'new body')).toThrow(/Validation Failed/)
    expect(calls).toBe(1)
  })

  it('gives up after the max attempts on a persistent transient error', () => {
    const gh = createExecGhService('t')
    let calls = 0
    execFileSync.mockImplementation(() => {
      calls += 1
      throw new Error('Command failed: gh pr edit 7 --body ...\nEOF')
    })
    expect(() => gh.prEdit(7, 'new body')).toThrow(/EOF/)
    expect(calls).toBe(3)
  })

  it('logs each retry attempt and the final give-up when a log is provided', () => {
    // Transparency: transient failures are retried silently by default (the
    // no-op logger); with a logger wired (production passes console.log), every
    // retry and the final give-up are surfaced so CI logs show what happened.
    const log = vi.fn()
    const gh = createExecGhService('t', log)
    execFileSync.mockImplementation(() => {
      throw new Error('Command failed: gh pr edit 7 --body ...\nEOF')
    })
    expect(() => gh.prEdit(7, 'new body')).toThrow(/EOF/)
    expect(log).toHaveBeenCalledTimes(3)
    expect(String(log.mock.calls[0][0])).toContain('attempt 1/3')
    expect(String(log.mock.calls[0][0])).toContain('retrying in 250ms')
    expect(String(log.mock.calls[1][0])).toContain('attempt 2/3')
    expect(String(log.mock.calls[1][0])).toContain('retrying in 500ms')
    expect(String(log.mock.calls[2][0])).toContain('attempt 3/3')
    expect(String(log.mock.calls[2][0])).not.toContain('retrying')
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
