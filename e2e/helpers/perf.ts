// e2e/helpers/perf.ts
// Performance probes for diagnosing interaction latency (INP) in the MarkFlow
// Electron app.
//
// Why this exists: the reported stutter happens in the FIRST FEW SECONDS after
// launch ("open a file right after startup, then immediately switch files"). A
// human cannot open DevTools, switch to the Performance panel and hit record
// inside that window — we measured this: a hand-made trace of a 2.9h session
// contained events only in its final 20s, i.e. entirely after the fact.
//
// So the recording has to be armed by code, BEFORE the app bundle runs.
//
// Three probes, because "the app feels stuck" has three very different causes:
//   1. MAIN process event-loop lag  -> whole app (all windows) unresponsive.
//      This is the one to check first and the one Web tooling never measures.
//   2. RENDERER long tasks (>50ms)  -> typing/clicking feels janky.
//   3. IPC round-trip time          -> the fetch itself is slow.
import type { ElectronApplication, Page } from 'playwright'

export interface MainSample {
  t: number
  delay: number
}
export interface LongTask {
  start: number
  dur: number
}
export interface SwitchSample {
  t0: number
  painted: number
}
export interface IpcSample {
  name: string
  t0: number
  dur: number
}
export interface RendererPerf {
  longTasks: LongTask[]
  switches: SwitchSample[]
  ipc: IpcSample[]
}

/**
 * Arm an event-loop lag probe inside the Electron MAIN process.
 *
 * A 20ms interval should fire every ~20ms. If the loop is blocked (sync fs,
 * heavy IPC handler, chokidar bookkeeping), the real gap balloons — that gap IS
 * the main-process stall, measured directly rather than inferred.
 */
export async function installMainProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>
    if (g.__mainProbe) return
    const samples: MainSample[] = []
    let last = process.hrtime.bigint()
    const timer = setInterval(() => {
      const now = process.hrtime.bigint()
      samples.push({ t: Date.now(), delay: Number(now - last) / 1e6 })
      last = now
    }, 20)
    g.__mainProbe = { samples, timer }
  })
}

/** Stop the main-process probe and return its samples. */
export async function collectMainProbe(electronApp: ElectronApplication): Promise<MainSample[]> {
  return electronApp.evaluate(() => {
    const g = globalThis as unknown as Record<string, { samples: MainSample[]; timer: unknown }>
    const p = g.__mainProbe
    if (!p) return []
    clearInterval(p.timer as NodeJS.Timeout)
    delete g.__mainProbe
    return p.samples
  })
}

/**
 * Renderer probe body. Passed to `addInitScript`, so it runs before the app
 * bundle — after that the probe must be followed by a reload() to take effect.
 */
export const rendererProbe = () => {
  const w = window as unknown as {
    __perf: RendererPerf
    api?: { documents?: Record<string, (...a: unknown[]) => Promise<unknown>> }
    PerformanceObserver?: typeof PerformanceObserver
  }
  w.__perf = { longTasks: [], switches: [], ipc: [] }

  // 2. Long tasks.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__perf.longTasks.push({ start: e.startTime, dur: e.duration })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* longtask not supported — the other probes still work */
  }

  // Interaction latency for sidebar document switches: click -> next painted
  // frame. Double rAF so we measure after the frame that actually rendered.
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target as HTMLElement | null
      if (!target?.closest?.('[data-testid="doc-item"]')) return
      const t0 = performance.now()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          w.__perf.switches.push({ t0, painted: performance.now() })
        }),
      )
    },
    true,
  )

  // 3. IPC timings. The preload API appears after this script runs, so wait for
  // it and then wrap the document fetch.
  const iv = setInterval(() => {
    const api = w.api?.documents
    if (!api?.get) return
    clearInterval(iv)
    const orig = api.get.bind(api)
    api.get = (...args: unknown[]) => {
      const t0 = performance.now()
      return orig(...args).then((r: unknown) => {
        w.__perf.ipc.push({ name: 'documents.get', t0, dur: performance.now() - t0 })
        return r
      })
    }
  }, 5)
}

export async function collectRendererProbe(page: Page): Promise<RendererPerf> {
  return page.evaluate(
    () =>
      (window as unknown as { __perf?: RendererPerf }).__perf ?? {
        longTasks: [],
        switches: [],
        ipc: [],
      },
  )
}

/** Order a numeric sample list and pick a percentile (0..100). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

export function summarize(values: number[]): string {
  if (values.length === 0) return 'n/a'
  const max = Math.max(...values)
  return (
    `n=${values.length} ` +
    `p50=${percentile(values, 50).toFixed(1)}ms ` +
    `p95=${percentile(values, 95).toFixed(1)}ms ` +
    `max=${max.toFixed(1)}ms`
  )
}
