// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Worker } from 'node:worker_threads'
import type { RegexScanRequest, RegexScanResponse } from './regex-scan.worker'
import { scanRegexBatch, REGEX_SCAN_TIMEOUT_MS } from './regex-runner'

// A stand-in for the thread: a real one would make "never replies" and "never resolves twice"
// impossible to observe. The factory is injected, which is the same seam the DiskIO ports use.
type Listener = (arg?: unknown) => void
function makeFakeWorker(behaviour: 'ok' | 'hang' | 'throw' | 'exit' | 'bad-compile') {
  const listeners: Record<string, Listener[]> = {}
  const w = {
    posted: null as unknown,
    terminated: false,
    paths: [] as string[],
    on(event: string, fn: Listener) {
      ;(listeners[event] ??= []).push(fn)
      return w
    },
    emit(event: string, arg?: unknown) {
      for (const fn of listeners[event] ?? []) fn(arg)
    },
    postMessage(req: { contents: string[] }) {
      w.posted = req
      if (behaviour === 'throw') {
        w.emit('error', new Error('cannot load'))
        return
      }
      if (behaviour === 'exit') {
        w.emit('exit', 1)
        return
      }
      if (behaviour === 'hang') return
      if (behaviour === 'bad-compile') {
        queueMicrotask(() => w.emit('message', { ok: false, message: 'bad pattern' }))
        return
      }
      const res: RegexScanResponse = {
        ok: true,
        results: req.contents.map(() => ({ matches: [], total: 0, capped: false })),
      }
      queueMicrotask(() => w.emit('message', res))
    },
    async terminate() {
      w.terminated = true
    },
  }
  return w
}

const req: RegexScanRequest = {
  query: 'x',
  opts: { matchCase: false, regexp: true, wholeWord: false },
  max: 50,
  contents: ['x', 'y'],
}

let current: ReturnType<typeof makeFakeWorker> | null = null
const spawn = (path: string): Worker => {
  current = makeFakeWorker('ok')
  current.paths.push(path)
  return current as unknown as Worker
}

beforeEach(() => {
  current = null
})

afterEach(() => {
  current = null
})

describe('scanRegexBatch (ADR-0023 D37)', () => {
  it('spawns the worker next to the main-process bundle and posts the request', async () => {
    const out = await scanRegexBatch(req, spawn)
    expect(current?.paths[0].endsWith('regex-scan.worker.js')).toBe(true)
    expect(out).toEqual({
      ok: true,
      results: [
        { matches: [], total: 0, capped: false },
        { matches: [], total: 0, capped: false },
      ],
    })
  })

  it('terminates the worker once the reply arrives', async () => {
    await scanRegexBatch(req, spawn)
    expect(current?.terminated).toBe(true)
  })

  it('gives up with a timeout and terminates the runaway worker', async () => {
    vi.useFakeTimers()
    try {
      const pending = scanRegexBatch(req, (path) => {
        current = makeFakeWorker('hang')
        current.paths.push(path)
        return current as unknown as Worker
      })
      await vi.advanceTimersByTimeAsync(REGEX_SCAN_TIMEOUT_MS)
      await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' })
      expect(current?.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves once only: a late message after the timeout is ignored', async () => {
    vi.useFakeTimers()
    try {
      const pending = scanRegexBatch(req, (path) => {
        current = makeFakeWorker('hang')
        current.paths.push(path)
        return current as unknown as Worker
      })
      await vi.advanceTimersByTimeAsync(REGEX_SCAN_TIMEOUT_MS)
      current?.emit('message', { ok: true, results: [] })
      await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unavailable when the worker raises instead of replying', async () => {
    const out = await scanRegexBatch(req, (path) => {
      current = makeFakeWorker('throw')
      current.paths.push(path)
      return current as unknown as Worker
    })
    expect(out).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('reports unavailable when the worker exits without replying', async () => {
    const out = await scanRegexBatch(req, (path) => {
      current = makeFakeWorker('exit')
      current.paths.push(path)
      return current as unknown as Worker
    })
    expect(out).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('reports unavailable when the factory throws outright', async () => {
    const out = await scanRegexBatch(req, () => {
      throw new Error('no such file')
    })
    expect(out).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('reports unavailable when the worker replies that the query did not compile', async () => {
    const out = await scanRegexBatch(req, (path) => {
      current = makeFakeWorker('bad-compile')
      current.paths.push(path)
      return current as unknown as Worker
    })
    expect(out).toEqual({ ok: false, reason: 'unavailable' })
  })
})
