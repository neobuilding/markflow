import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mkTestDir } from '../test-support/tmp'

const { getDocumentById, protocolHandle } = vi.hoisted(() => ({
  getDocumentById: vi.fn(),
  protocolHandle: vi.fn(),
}))
vi.mock('../model/documentStore', () => ({ getDocumentById }))
vi.mock('electron', () => ({ protocol: { handle: protocolHandle } }))

import { resolveAppdocPath, registerAppDocProtocol } from './appdoc'

const dir = mkTestDir('mf-appdoc-')
beforeAll(() => {
  writeFileSync(join(dir, 'im.png'), 'PNG')
  // leave 'missing.png' absent on purpose
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveAppdocPath', () => {
  const docId = 'd1'
  const doc = { id: docId, filePath: join(dir, 'doc.md') }

  it('returns null for a malformed appdoc URL (PLAN §12-3)', () => {
    expect(resolveAppdocPath('appdoc:///im.png')).toBeNull()
  })

  it('returns null for an unknown document', () => {
    getDocumentById.mockReturnValueOnce(null)
    expect(resolveAppdocPath('appdoc://ghost/im.png')).toBeNull()
  })

  it('returns null when the document has no file path', () => {
    getDocumentById.mockReturnValueOnce({ id: docId })
    expect(resolveAppdocPath('appdoc://d1/im.png')).toBeNull()
  })

  it('returns null when the path escapes the document directory', () => {
    getDocumentById.mockReturnValueOnce(doc)
    expect(resolveAppdocPath('appdoc://d1/../escape.png')).toBeNull()
  })

  it('returns null when the resolved file is missing', () => {
    getDocumentById.mockReturnValueOnce(doc)
    expect(resolveAppdocPath('appdoc://d1/missing.png')).toBeNull()
  })

  it('returns the resolved on-disk path for an existing file', () => {
    getDocumentById.mockReturnValueOnce(doc)
    expect(resolveAppdocPath('appdoc://d1/im.png')).toBe(join(dir, 'im.png'))
  })

  it('passes disk paths through untouched', () => {
    expect(resolveAppdocPath('/abs/path.png')).toBe('/abs/path.png')
  })
})

describe('registerAppDocProtocol', () => {
  const docId = 'd1'
  const doc = { id: docId, filePath: join(dir, 'doc.md') }

  beforeEach(() => {
    protocolHandle.mockClear()
    getDocumentById.mockReset()
    writeFileSync(join(dir, 'im.png'), 'PNGDATA')
  })

  const handler = () => protocolHandle.mock.calls[0][1] as (req: Request) => Promise<Response>

  it('serves a valid appdoc request with its content type (PLAN §4.1)', async () => {
    getDocumentById.mockReturnValue(doc)
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc://d1/im.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('image/png')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
  })

  it('serves an unknown extension with the octet-stream fallback type', async () => {
    getDocumentById.mockReturnValue(doc)
    writeFileSync(join(dir, 'data.xyz'), 'BINARY')
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc://d1/data.xyz'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('returns 404 for an unknown document', async () => {
    getDocumentById.mockReturnValue(null)
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc://ghost/im.png'))
    expect(res.status).toBe(404)
  })

  it('returns 404 when the resolved file is missing', async () => {
    getDocumentById.mockReturnValue(doc)
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc://d1/missing.png'))
    expect(res.status).toBe(404)
  })

  it('returns 404 for a traversal-style URL (containment is enforced by URL parsing)', async () => {
    getDocumentById.mockReturnValue(doc)
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc://d1/../escape.png'))
    expect(res.status).toBe(404)
  })

  it('returns 404 for a malformed appdoc URL', async () => {
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc:///im.png'))
    expect(res.status).toBe(404)
  })

  it('returns 500 when the document lookup throws', async () => {
    getDocumentById.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    registerAppDocProtocol()
    const res = await handler()(new Request('appdoc://d1/im.png'))
    expect(res.status).toBe(500)
  })
})
