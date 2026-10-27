// Main-process side of the regex-scan Worker (ADR-0023 D37). See `regex-scan.worker.ts` for why
// the isolation exists.
//
// Contract with the caller:
//   ok            → results, one entry per requested body, in order.
//   'timeout'     → the pattern ran longer than the budget. The Worker has been terminated, so the
//                   run really did stop; the caller must surface this (fail-closed), never
//                   silently return the results computed so far.
//   'unavailable' → the Worker could not be started at all (missing / unloadable bundle). The scan
//                   is still answerable, so the caller falls back to running it in-process; that
//                   path has no timeout, which is precisely why it is the fallback and not the plan.
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RegexScanItem, RegexScanRequest, RegexScanResponse } from './regex-scan.worker'

// Budget for one regex scan. It can be generous because the main thread stays free while the
// Worker runs — a slow scan costs the user only waiting, and the Search view shows a cancel button
// throughout. It is long enough not to truncate a legitimate scan of a large workspace, and short
// enough that a catastrophic pattern is destroyed while the app is still usable.
export const REGEX_SCAN_TIMEOUT_MS = 10_000

// Built next to the main-process bundle (`dist/electron/regex-scan.worker.js`, see the extra
// bundling slot in `vite.config.ts`).
function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'regex-scan.worker.js')
}

export type RegexScanOutcome =
  { ok: true; results: RegexScanItem[] } | { ok: false; reason: 'timeout' | 'unavailable' }

/**
 * How a Worker gets created. Injectable so the timeout and the failure paths are testable without
 * spawning real threads — the same dependency-injection shape the DiskIO ports use.
 */
export type WorkerFactory = (path: string) => Worker

export async function scanRegexBatch(
  req: RegexScanRequest,
  spawn: WorkerFactory = (path) => new Worker(path),
): Promise<RegexScanOutcome> {
  let worker: Worker
  try {
    worker = spawn(workerPath())
  } catch {
    return { ok: false, reason: 'unavailable' }
  }

  return new Promise<RegexScanOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: RegexScanOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(outcome)
    }

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), REGEX_SCAN_TIMEOUT_MS)

    worker.on('message', (res: RegexScanResponse) => {
      finish(res.ok ? { ok: true, results: res.results } : { ok: false, reason: 'unavailable' })
    })
    // A missing or broken bundle surfaces here rather than at construction time.
    worker.on('error', () => finish({ ok: false, reason: 'unavailable' }))
    worker.on('exit', () => finish({ ok: false, reason: 'unavailable' }))

    worker.postMessage(req)
  })
}
