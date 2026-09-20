// e2e/helpers/large-doc-perf.ts
// Measurement primitives for the LARGE-DOCUMENT preview performance diagnostic
// (e2e/perf/large-doc-perf.e2e.spec.ts).
//
// Why this is separate from perf-fixture.ts: that helper measures the "open a
// folder then switch files" chokidar scenario (many small docs). This one measures
// ONE very large document, because the Phase-03 optimisation candidates — mermaid
// lazy-render (D-E), image intrinsic size (R9) and block-level incremental render
// (D-D) — are all about single-document cost, which the folder scenario cannot see.
//
// Everything here is deliberately passive: it only observes (PerformanceObserver /
// DOM counts / process.memoryUsage) and never changes app behaviour, so the numbers
// are comparable before and after the Phase-03 changes.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { ElectronApplication, Page } from 'playwright'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Self-contained performance fixture (see plan §8 Step 2). The fixture doc `demo-large.md`
 * is a committed copy of `examples/demo-large.en.md` (produced by `examples/generate-large.mjs`,
 * which also emits the Chinese sibling `examples/demo-large.zh-CN.md`). The whole directory
 * (md + assets, including the R9 big image `pic-tall.png`) is copied to a temp scratch before
 * import, so typing can never touch the committed copy.
 */
export const E2E_FIXTURE_DIR = join(PROJECT_ROOT, 'e2e', 'fixtures', 'large-doc')
export const LARGE_DOC_NAME = 'demo-large.md'

/** Run artifacts go under reports/ (git-ignored) — never dirty the work tree. */
export const RESULTS_DIR = join(PROJECT_ROOT, 'reports', 'perf')

/**
 * Optional committed baseline. It does NOT exist until someone decides the numbers
 * are stable enough to freeze (run with PERF_UPDATE_BASELINE=1 to write it).
 * Until then the diagnostic only records + prints.
 */
export const BASELINE_PATH = join(PROJECT_ROOT, 'e2e', 'perf', 'baselines', 'large-doc.json')

export interface LargeDocMetrics {
  // ── structure actually rendered (guards against a vacuous perf run) ──
  /** `[data-mermaid-slot]` placeholders the pipeline emitted. */
  mermaidSlots: number
  /** Placeholders that ended up with an <svg> (pre-D-E: all of them). */
  mermaidRendered: number
  /** Local (`appdoc://`) images in the preview. */
  localImages: number
  /** Local images that finished loading (naturalWidth > 0). */
  localImagesLoaded: number
  /** Top-level blocks carrying a `data-line` mapping (R6) — the D-D granularity. */
  blocks: number

  // ── timings (wall-clock ms, measured from activating the document) ──
  /** Activation -> first preview text on screen. */
  firstContentMs: number
  /** Activation -> the FIRST (top-most) diagram is an <svg>. Comparable across
   *  the D-E change, unlike "all diagrams", which lazy-render will (by design)
   *  never reach for off-screen charts. */
  firstMermaidMs: number
  /** Activation -> every local image decoded. */
  localImagesMs: number
  /** Editor input -> the new block is visible in the preview (D-D / D-E cost). */
  typeToPreviewMs: number
  /** Single keystroke -> the inserted text is visible in the preview (per-keystroke proxy). */
  typeCharToPreviewMs: number

  // ── jitter (R9): cumulative layout shift while the document settles ──
  /** CLS = sum of non-input layout-shift values. Target after R9 ≈ 0. */
  cls: number
  clsCount: number
  clsMax: number

  // ── renderer long tasks (>50ms) during the load + type window ──
  longTaskCount: number
  longTaskTotalMs: number
  longTaskMaxMs: number

  // ── main-process event-loop lag (perf.ts semantics) ──
  mainP95Ms: number
  mainStallMs: number
  mainMaxLagMs: number

  // ── memory (bytes) ──
  mainHeapUsed: number
  mainRss: number
  rendererHeapUsed: number | null
}

/**
 * Arm passive probes BEFORE the document is activated: long tasks (>50ms) and
 * layout shifts. Both are read back by collectLoadProbe().
 *
 * Done with page.evaluate rather than addInitScript+reload (the folder-switch
 * diagnostic does the latter): we only care about the window that starts when the
 * document is activated, and reloading would reset the app for no gain.
 */
export async function installLoadProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__largeDoc = { longTasks: [] as { start: number; dur: number }[], cls: [] as number[] }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          w.__largeDoc.longTasks.push({ start: e.startTime, dur: e.duration })
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      /* longtask unsupported — the other metrics still work */
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as any[]) {
          // hadRecentInput entries are user-driven and must be excluded from CLS
          // (the standard definition), otherwise our own editor click would count.
          if (e.hadRecentInput) continue
          w.__largeDoc.cls.push(e.value as number)
        }
      }).observe({ type: 'layout-shift', buffered: false })
    } catch {
      /* layout-shift unsupported */
    }
  })
}

export async function collectLoadProbe(page: Page): Promise<{
  longTasks: { start: number; dur: number }[]
  cls: number[]
}> {
  return page.evaluate(
    () =>
      (window as any).__largeDoc ?? {
        longTasks: [],
        cls: [],
      },
  )
}

/** Count the structural landmarks that prove the real document rendered. */
export async function countStructure(page: Page): Promise<{
  mermaidSlots: number
  mermaidRendered: number
  localImages: number
  localImagesLoaded: number
  blocks: number
}> {
  return page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll('[data-mermaid-slot]'))
    const imgs = Array.from(document.querySelectorAll('article.markdown-preview img')).filter((i) =>
      (i.getAttribute('src') ?? '').startsWith('appdoc://'),
    )
    return {
      mermaidSlots: slots.length,
      mermaidRendered: slots.filter((s) => s.querySelector('svg')).length,
      localImages: imgs.length,
      localImagesLoaded: imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length,
      blocks: document.querySelectorAll('article.markdown-preview > [data-line]').length,
    }
  })
}

/**
 * Wait until every LOCAL (`appdoc://`) image is decoded. The fixture also contains
 * one remote image on purpose: it needs the network, so waiting on it would hang on
 * an offline/CI machine — local images are what R9 is about anyway.
 */
export async function waitForLocalImages(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('article.markdown-preview img')).filter(
        (i) => (i.getAttribute('src') ?? '').startsWith('appdoc://'),
      )
      return imgs.length > 0 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)
    },
    undefined,
    { timeout: timeoutMs },
  )
}

/** Main-process memory snapshot (bytes). */
export async function readMainMemory(
  electronApp: ElectronApplication,
): Promise<{ heapUsed: number; rss: number }> {
  return electronApp.evaluate(() => {
    const m = process.memoryUsage()
    return { heapUsed: m.heapUsed, rss: m.rss }
  })
}

/** Renderer JS heap (bytes) when exposed; null when the runtime omits it. */
export async function readRendererHeap(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const mem = (performance as any).memory
    return typeof mem?.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : null
  })
}

export interface PerfRunRecord {
  name: string
  timestamp: string
  commit: string | null
  node: string
  platform: string
  doc: string
  metrics: LargeDocMetrics
}

function gitCommit(): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' })
    return r.status === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/** Persist a run as `<name>-<timestamp>.json` plus `<name>-latest.json`. */
export function writeRunRecord(name: string, metrics: LargeDocMetrics, doc: string): string[] {
  const record: PerfRunRecord = {
    name,
    timestamp: new Date().toISOString(),
    commit: gitCommit(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    doc,
    metrics,
  }
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = record.timestamp.replace(/[:.]/g, '-')
  const stamped = join(RESULTS_DIR, `${name}-${stamp}.json`)
  const latest = join(RESULTS_DIR, `${name}-latest.json`)
  writeFileSync(stamped, JSON.stringify(record, null, 2))
  writeFileSync(latest, JSON.stringify(record, null, 2))
  return [stamped, latest]
}

/**
 * Freeze the current metrics as the committed baseline (opt-in). Returns the path,
 * or null when PERF_UPDATE_BASELINE is not set.
 */
export function maybeWriteBaseline(name: string, metrics: LargeDocMetrics): string | null {
  if (process.env.PERF_UPDATE_BASELINE !== '1') return null
  mkdirSync(dirname(BASELINE_PATH), { recursive: true })
  const payload = {
    name,
    frozenAt: new Date().toISOString(),
    commit: gitCommit(),
    note: 'Frozen by PERF_UPDATE_BASELINE=1. Compare against this when reviewing Phase-03.',
    metrics,
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2))
  return BASELINE_PATH
}

/** Read the committed baseline, or null when none has been frozen yet. */
export function readBaseline(): { metrics: LargeDocMetrics; commit: string | null } | null {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as {
      metrics: LargeDocMetrics
      commit: string | null
    }
    return raw.metrics ? { metrics: raw.metrics, commit: raw.commit } : null
  } catch {
    return null
  }
}

/**
 * Human-readable baseline delta. Timing metrics use `current - baseline` (lower is
 * better); structure metrics are reported as-is since a fixture change would move
 * them legitimately.
 */
export function baselineDelta(current: LargeDocMetrics, baseline: LargeDocMetrics): string[] {
  const timingKeys: (keyof LargeDocMetrics)[] = [
    'firstContentMs',
    'firstMermaidMs',
    'localImagesMs',
    'typeToPreviewMs',
    'typeCharToPreviewMs',
    'cls',
    'longTaskCount',
    'longTaskTotalMs',
    'longTaskMaxMs',
    'mainP95Ms',
    'mainStallMs',
    'mainMaxLagMs',
  ]
  const out: string[] = []
  for (const k of timingKeys) {
    const a = current[k]
    const b = baseline[k]
    if (typeof a !== 'number' || typeof b !== 'number') continue
    const d = a - b
    const pct = b !== 0 ? ((d / b) * 100).toFixed(0) + '%' : 'n/a'
    const flag = d > 0 ? '(+slower)' : d < 0 ? '(-faster)' : ''
    out.push(
      `  ${String(k).padEnd(18)} ${String(a).padStart(9)}  vs ${String(b).padStart(9)}   ${pct} ${flag}`,
    )
  }
  return out
}
