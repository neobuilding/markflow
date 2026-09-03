// PERFORMANCE REGRESSION GATE (runs in CI as part of `npm run e2e`).
//
// Guards the chokidar-lag root cause: the folder watcher must watch MARKDOWN
// ONLY. Opening a folder buried under non-md build output (coverage reports,
// dist/, release/, images, sources…) must therefore not stall the main process.
//
// Measured on this repo before the fix (680 entries, only 16 of them markdown):
// up to 8 main-process stalls of >100ms, worst ~2s, right after opening a folder.
// After the fix the same folder shows at most one brief stall. The thresholds
// below sit comfortably above the fixed behaviour and far below the broken one,
// so the regression cannot silently come back.
//
// This spec is deliberately separate from the diagnostic spec
// (switch-perf.e2e.spec.ts), which has NO thresholds and is never run in CI:
// a gate must be small, deterministic and fast enough for every PR.
//
// Run alone:  npx playwright test --project=electron-perf-gate
import { test, expect } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp } from '../helpers/launch'
import { installMainProbe, collectMainProbe } from '../helpers/perf'
import {
  makeNoisyFolder,
  openFolder,
  switchToNext,
  summarizeMainLag,
} from '../helpers/perf-fixture'

// How much non-markdown noise to bury the docs in. Each "noise file" writes
// three files (js + css + png), so 200 => 600 non-md entries. Big enough to be
// felt by a watcher that crawls everything; small enough to keep the gate quick.
const NOISE = Number(process.env.PERF_NOISE ?? 200)
const DOCS = 6
const ROUNDS = 3

// ─── Thresholds ────────────────────────────────────────────────────────────
//
// ONE set of numbers, used on CI and locally alike. An earlier version applied a
// multiplier on CI to absorb slower shared runners; that was removed because CI
// runner speed cannot be reproduced locally, so any such factor is an untestable
// guess. A single threshold is at least honest about what was measured where.
//
// Calibrated by deliberately reverting the fix (watcher changed to watch
// EVERYTHING) and re-measuring the same fixture repeatedly, ~7 runs per state:
//
//                       p95              stallMs        maxLag
//   fixed  (md only)    33.1 - 49.7ms     0 - 63         67 - 136ms
//   broken (all)        61.2 - 111.1ms   32 - 201       117 - 193ms
//
// p95 is the ONLY metric with a gap between the two states (49.7 -> 61.2), so it
// is the primary gate and 55 sits in that gap. stallMs and maxLag OVERLAP across
// the states (63 vs 32, and 136 vs 117) — they cannot separate fixed from broken
// and are kept only as backstops against a gross freeze the p95 would smooth away.
//
// ⚠️ KNOWN WEAKNESS, and it is significant: the gap is ~11ms wide on top of
// measurements that swing by 6x between identical runs (the same BUILD produced
// stallMs 34 and 201). Under a different machine load the fixed state can exceed
// 55 and the broken state can fall under it. In practice: expect this gate to
// flake occasionally, and do NOT trust a green run as proof the watcher filters.
//
// The deterministic guarantee that the watcher filters is the functional e2e
// "only watches markdown" case — it asserts behaviour and has no timing
// dependence. This gate is only a backstop for the COST of watching.
//
// Override for ad-hoc runs:  PERF_MAX_P95=300 npx playwright test --project=electron-perf-gate
const MAX_P95_MS = Number(process.env.PERF_MAX_P95 ?? 55)
const MAX_STALL_MS = Number(process.env.PERF_MAX_STALL_MS ?? 150)
const MAX_LAG_MS = Number(process.env.PERF_MAX_LAG ?? 250)

test.describe('document switch performance gate', () => {
  test('opening a folder full of non-md build output does not stall the main process', async () => {
    const handle = await launchApp()
    const { electronApp, page } = handle
    try {
      await installMainProbe(electronApp)

      const dir = makeNoisyFolder(DOCS, NOISE)

      // Open + IMMEDIATELY switch, the reported repro window. Several rounds so a
      // stray one-off stall does not flake the gate.
      const opens: number[] = []
      const switches: number[] = []
      for (let round = 0; round < ROUNDS; round++) {
        await page.reload()
        await waitForAppReady(page)
        const o = await openFolder(page, dir)
        opens.push(o.ms)
        switches.push(await switchToNext(page))
      }

      const { spikes, maxLag, count, p95, stallMs } = summarizeMainLag(
        await collectMainProbe(electronApp),
      )

      console.log('\n=== MAIN-PROCESS STALL GATE (non-md noise folder) ===')
      console.log(`  docs: ${DOCS}   non-md noise files: ${NOISE * 3}   rounds: ${ROUNDS}`)
      console.log(
        `  samples: ${count}   spikes>100ms: ${spikes.length}   maxLag: ${maxLag.toFixed(1)}ms` +
          `   p95: ${p95.toFixed(1)}ms   stallMs: ${stallMs.toFixed(0)}`,
      )
      console.log(
        `  thresholds: p95<${MAX_P95_MS}ms  stallMs<=${MAX_STALL_MS}  maxLag<${MAX_LAG_MS}ms`,
      )
      console.log(`  open(ms): ${opens.map((v) => v.toFixed(0)).join(', ')}`)
      console.log(`  switch(ms): ${switches.map((v) => v.toFixed(0)).join(', ')}`)

      // Gate, in order of what each metric can actually distinguish (see the
      // threshold notes above). p95 first: it is the ONLY metric with a gap
      // between the fixed and broken states. stallMs and maxLag follow as
      // backstops — their distributions overlap across the two states, so they
      // only catch a gross freeze that the p95 would smooth away.
      expect(
        p95,
        'p95 main-process event-loop lag (is the watcher watching non-md files?)',
      ).toBeLessThan(MAX_P95_MS)
      expect(stallMs, 'total main-process stall time').toBeLessThanOrEqual(MAX_STALL_MS)
      expect(maxLag, 'maximum main-process event-loop lag').toBeLessThan(MAX_LAG_MS)
    } finally {
      await closeApp(handle)
    }
  })
})
