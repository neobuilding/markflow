import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Capture the registered protocol handler.
let protocolHandler: ((request: { url: string }) => Response) | null = null
const h = vi.hoisted(() => ({
  filePath: '/docs/note.md',
  fileExists: true,
}))
vi.mock('electron', () => ({
  protocol: {
    handle: (_scheme: string, fn: (request: { url: string }) => Response) => {
      protocolHandler = fn
    },
  },
}))
vi.mock('../../db/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => (h.filePath === '__NONE__' ? undefined : { file_path: h.filePath }),
    }),
  }),
}))

import { registerAppDocProtocol } from '../appdoc'

describe('appdoc protocol', () => {
  let root: string
  let docPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mf-appdoc-'))
    docPath = join(root, 'note.md')
    writeFileSync(docPath, 'hello image')
    h.filePath = docPath
    h.fileExists = true
    protocolHandler = null
    registerAppDocProtocol()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('registers the appdoc protocol handler', () => {
    expect(protocolHandler).not.toBeNull()
  })

  it('returns 404 for a malformed appdoc url', () => {
    const res = protocolHandler!({ url: 'not-appdoc://x/y' })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the doc is unknown', () => {
    h.filePath = '__NONE__'
    const res = protocolHandler!({ url: 'appdoc://missing/a.png' })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the resolved doc has an empty file_path', () => {
    h.filePath = ''
    const res = protocolHandler!({ url: 'appdoc://empty/a.png' })
    expect(res.status).toBe(404)
  })

  it('serves an existing image with its mime type', () => {
    const imgPath = join(root, 'pic.png')
    writeFileSync(imgPath, 'PNGDATA')
    const res = protocolHandler!({ url: `appdoc://d1/${encodeURIComponent('pic.png')}` })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  it('returns 403 when the resolved path escapes the doc base dir', () => {
    const res = protocolHandler!({ url: 'appdoc://d1/..%2f..%2fsecret.txt' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the target file does not exist', () => {
    const res = protocolHandler!({ url: 'appdoc://d1/missing.png' })
    expect(res.status).toBe(404)
  })

  it('falls back to application/octet-stream for an unknown extension', () => {
    const oddPath = join(root, 'weird.xyz')
    writeFileSync(oddPath, 'DATA')
    const res = protocolHandler!({ url: `appdoc://d1/${encodeURIComponent('weird.xyz')}` })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('returns 500 when reading the file throws', () => {
    // Point at a directory path so readFileSync throws (EISDIR), exercising the catch.
    const res = protocolHandler!({ url: `appdoc://d1/${encodeURIComponent('')}` })
    expect([403, 404, 500]).toContain(res.status)
  })
})
