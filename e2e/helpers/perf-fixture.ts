// Shared fixture + measurement helpers for the performance specs (e2e/perf).
//
// Split out of the specs themselves so the CI gate (switch-perf-gate) and the
// on-demand diagnostic (switch-perf) drive the EXACT same code path. A gate that
// drifts from the diagnostic it was derived from stops guarding anything: it would
// keep passing while the scenario it was written for regresses.
import { mkdirSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { summarize, percentile, type MainSample } from './perf'
import type { AppHandle } from './launch'

// Markdown extensions recognised by the app (mirrors MD_EXTS in
// electron/main/lib/markdown-ext.ts).
const MD_EXTS = new Set(['.md', '.markdown', '.mdx', '.mdtxt', '.mdtext'])

// Tunables for the diagnostic spec. Kept as module-level constants so a CI gate
// never inherits them by accident (the gate fixes its own, much smaller, inputs).
export const DOCS = Number(process.env.PERF_DOCS ?? 10)
export const SUBDIR_DOCS = Number(process.env.PERF_SUBDIR_DOCS ?? 0)
export const SUBDIR_DEPTH = Number(process.env.PERF_SUBDIR_DEPTH ?? 0)
export const COLD_ROUNDS = Number(process.env.PERF_COLD_ROUNDS ?? 4)

// Point the diagnostic at a REAL folder instead of generating a synthetic one:
// synthetic fixtures are near-empty markdown files and cannot reproduce costs that
// come from real content.   PERF_FOLDER=D:/GitHub/markflow npm run e2e:perf
export const REAL_FOLDER = process.env.PERF_FOLDER?.trim() || ''

/**
 * Count the markdown files a real folder would import. Mirrors
 * `collectMarkdownFiles` (electron/main/lib/md-files.ts): skips dot dirs and
 * node_modules, recurses, and matches by extension.
 */
export function countMarkdownFiles(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) total += countMarkdownFiles(full)
        else if (MD_EXTS.has(name.slice(name.lastIndexOf('.')).toLowerCase())) total += 1
      } catch {
        /* unreadable entry — mirrors collectMarkdownFiles */
      }
    }
  } catch {
    /* unreadable dir */
  }
  return total
}

/**
 * Build a folder of markdown files. Root level gets `n` files; optionally also
 * build nested sub-directories (chokidar watches recursively, so depth is part
 * of what it has to crawl).
 */
export function makeFixture(n: number, subPerDir: number, depth: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'markflow-perf-'))
  const langs = ['js', 'python', 'bash', 'json', 'ts', 'yaml', 'go', 'rust', 'sql', 'html']
  const write = (folder: string, i: number, tag: string) =>
    writeFileSync(
      join(folder, `doc${tag}${i}.md`),
      `# Doc ${tag}${i}\n\nprose ${tag}${i}\n\n\`\`\`${langs[i % langs.length]}\nconst x = ${i}\n\`\`\`\n`,
    )
  for (let i = 0; i < n; i++) write(dir, i, '')
  let cur = dir
  for (let d = 0; d < depth; d++) {
    cur = join(cur, `level${d}`)
    mkdirSync(cur, { recursive: true })
    for (let i = 0; i < subPerDir; i++) write(cur, i, `d${d}_`)
  }
  return dir
}

/**
 * Build a folder that mixes a few real markdown docs with a large pile of
 * non-markdown "build output" (js / css / png) that the watcher MUST ignore.
 *
 * This is the fixture the chokidar-lag regression gate uses: before the fix the
 * watcher crawled and watched every one of these files, which is what made
 * "open a folder, then immediately switch files" stutter.
 */
export function makeNoisyFolder(docs: number, noiseFiles: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'markflow-perf-noise-'))
  const writeDoc = (folder: string, i: number) =>
    writeFileSync(
      join(folder, `doc${i}.md`),
      `# Doc ${i}\n\nprose\n\n\`\`\`js\nconst x = ${i}\n\`\`\`\n`,
    )
  const writeNoise = (folder: string, i: number) => {
    writeFileSync(join(folder, `dist-${i}.js`), 'console.log(1)')
    writeFileSync(join(folder, `style-${i}.css`), '.x{}')
    writeFileSync(
      join(folder, `shot-${i}.png`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'binary',
    )
  }
  for (let i = 0; i < docs; i++) writeDoc(dir, i)
  for (let i = 0; i < noiseFiles; i++) writeNoise(dir, i)
  // Deliberately FLAT — do not add noise sub-directories here. Depth was tried
  // and made the gate worse, not better: collecting the markdown files requires
  // walking the whole tree regardless of what chokidar watches, so a deeper
  // fixture raises the FIXED baseline too (measured: maxLag went 110ms -> 374ms
  // with two extra levels) instead of widening the gap the gate measures.
  return dir
}

/**
 * Open a folder through the real pipeline (resolve -> import -> watch -> activate).
 * Returns the ms it took, since with a large folder the import itself can be a
 * major cost — and chokidar starts watching as part of this same step.
 */
export async function openFolder(
  page: AppHandle['page'],
  folder: string,
): Promise<{ ms: number; imported: number; shown: number }> {
  const t0 = Date.now()
  const imported = await page.evaluate(async (f) => {
    const w = window as any
    const { markdownFiles } = await w.api.files.resolvePaths([f])
    const docs = await w.api.documents.importMany(markdownFiles)
    await w.api.documents.setOpenFolder(f)
    const ui = w.__uiStore.getState()
    ui.setActiveFolder(f)
    if (docs.length > 0) ui.setActiveDocumentId(docs[0].id)
    return { resolved: markdownFiles.length, imported: docs.length }
  }, folder)
  // Do not hard-assert an exact count on a real folder: how many entries resolve
  // vs how many the sidebar shows can legitimately differ (unreadable files,
  // folder filtering). Assert "at least one", then report the real numbers.
  await page.locator('[data-testid="doc-item"]').first().waitFor({ state: 'visible' })
  const shown = await page.locator('[data-testid="doc-item"]').count()
  return { ms: Date.now() - t0, imported: imported.imported, shown }
}

/**
 * Click a sidebar document and return the wall-clock ms until the new document
 * is actually on screen.
 *
 * The sidebar is ordered by updatedAt (desc), NOT by name, so a given index does
 * not map to a stable document — and clicking the already-active one changes
 * nothing. So we walk the items and skip any click that does not change the
 * active document id; only a real switch is timed.
 */
export async function switchToNext(page: AppHandle['page']): Promise<number> {
  // Pick the target from the DOM itself, not from the query cache: the cache can
  // hold more entries than the sidebar renders (sub-folder docs, memory-only
  // drafts), so an index computed from it may point past the last rendered item
  // and click() would hang forever (this is exactly what happened at 500 docs).
  const items = page.locator('[data-testid="doc-item"]')
  // Read the active row straight from the DOM: DocItem marks it with the
  // accent-muted class (there is no data attribute for it). Comparing against
  // titles from the query cache is unreliable — that cache can hold more entries
  // than the sidebar renders, and title text alone cannot tell us which row is
  // actually selected.
  const info = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-testid="doc-item"]'))
    const activeIdx = els.findIndex((el) => el.className.includes('accent-muted'))
    return { activeIdx, count: els.length }
  })
  if (info.count < 2) throw new Error(`switchToNext: need >=2 items, got ${info.count}`)
  const target = info.activeIdx >= 0 ? (info.activeIdx + 1) % info.count : 1

  const before = await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '')
  const t0 = Date.now()
  await items.nth(target).click()
  await page.waitForFunction(
    (prev) => {
      const text = document.querySelector('.cm-content')?.textContent ?? ''
      return text.length > 0 && text !== prev
    },
    before,
    { timeout: 20_000 },
  )
  return Date.now() - t0
}

/** Pretty-print the main-process event-loop lag samples. */
export function reportMainLag(samples: MainSample[]): void {
  if (samples.length === 0) {
    console.log('\n[main process] no samples collected')
    return
  }
  const delays = samples.map((s) => s.delay)
  const spikes = samples.filter((s) => s.delay > 100)
  console.log('\n=== MAIN PROCESS EVENT-LOOP LAG (target interval 20ms) ===')
  console.log('samples:', samples.length)
  console.log('  ' + summarize(delays))
  console.log('  spikes >100ms:', spikes.length)
  for (const s of spikes.slice(0, 12)) {
    console.log(`    +${s.delay.toFixed(1)}ms at ${new Date(s.t).toISOString().slice(11, 23)}`)
  }
}

/** Stall threshold: the probe ticks every 20ms, so >100ms is a real freeze. */
export const STALL_MS = 100

/**
 * Summarise main-process event-loop lag for the regression gate.
 *
 * `stallMs` (total time spent stalled) is the PRIMARY metric, not `spikes`
 * (count of stalls). The count turned out to be unusable as a gate: repeatedly
 * running the SAME fixed build produced 1, 2, 3 and 5 stalls, which overlaps the
 * 5 a deliberately-broken build produces — pure scheduling noise on a busy
 * machine. Total stalled time integrates how long the loop was actually blocked
 * and varies far less between identical runs.
 *
 * `p95` is reported alongside it as a secondary signal, and `spikes`/`maxLag`
 * are still returned for the diagnostic printout.
 */
export function summarizeMainLag(samples: MainSample[]): {
  spikes: MainSample[]
  maxLag: number
  count: number
  p95: number
  stallMs: number
} {
  const delays = samples.map((s) => s.delay)
  const stalled = delays.filter((d) => d > STALL_MS)
  return {
    spikes: samples.filter((s) => s.delay > STALL_MS),
    maxLag: delays.length ? Math.max(...delays) : 0,
    count: delays.length,
    p95: percentile(delays, 95) || 0,
    // Time beyond the stall threshold only: the ~20ms baseline tick is normal and
    // summing it would just measure how long the test ran.
    stallMs: stalled.reduce((sum, d) => sum + (d - STALL_MS), 0),
  }
}
