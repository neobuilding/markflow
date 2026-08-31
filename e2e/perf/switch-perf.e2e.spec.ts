// DIAGNOSTIC performance spec — measures how long a document switch takes.
//
// This is NOT a pass/fail gate: it has no thresholds, because its job is to
// answer, with numbers instead of guesses, questions a gate cannot:
//   * Is the switch slow in the MAIN process (event loop blocked -> whole app
//     frozen) or in the RENDERER (main thread busy -> janky but responsive)?
//   * Is it a COLD-start cost (first switch after opening a folder) or does it
//     happen on every switch?
//   * Are long tasks / IPC round-trips involved?
//
// It is excluded from `npm run e2e` (and therefore from CI) on purpose — it
// reloads the app several times and is slow by design. The regression gate that
// DOES run in CI lives beside it in switch-perf-gate.e2e.spec.ts and shares
// every helper through e2e/helpers/perf-fixture.ts.
//
// Reproduces the reported scenario: right after launch, open a folder and
// immediately switch files.
//
// Run:  npm run e2e:perf
//   PERF_FOLDER=D:/GitHub/markflow npm run e2e:perf     # measure a real folder
//   PERF_DOCS=500 PERF_SUBDIR_DOCS=20 PERF_SUBDIR_DEPTH=2 npm run e2e:perf
import { test } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp } from '../helpers/launch'
import {
  installMainProbe,
  collectMainProbe,
  collectRendererProbe,
  rendererProbe,
  summarize,
} from '../helpers/perf'
import {
  DOCS,
  SUBDIR_DOCS,
  SUBDIR_DEPTH,
  COLD_ROUNDS,
  REAL_FOLDER,
  countMarkdownFiles,
  makeFixture,
  openFolder,
  switchToNext,
  reportMainLag,
} from '../helpers/perf-fixture'

test.describe('document switch latency (diagnostic)', () => {
  test('cold (immediately after opening a folder) vs warm (repeated)', async () => {
    const handle = await launchApp()
    const { electronApp, page } = handle

    try {
      await installMainProbe(electronApp)
      // Arm the renderer probe for all future navigations, then reload so it is
      // live from the app's very first instruction — no human can start a
      // recording fast enough to catch this window.
      await electronApp.context().addInitScript(rendererProbe)

      // With PERF_FOLDER the document count is whatever that folder contains, so
      // it is discovered instead of asserted.
      const folder = REAL_FOLDER || makeFixture(DOCS, SUBDIR_DOCS, SUBDIR_DEPTH)
      const expected = REAL_FOLDER ? await countMarkdownFiles(folder) : DOCS

      // ---------- COLD: reload -> open -> switch IMMEDIATELY, once per round ----------
      const cold: number[] = []
      const opens: number[] = []
      const importCounts: string[] = []
      for (let round = 0; round < COLD_ROUNDS; round++) {
        await page.reload()
        await waitForAppReady(page)
        const o = await openFolder(page, folder)
        opens.push(o.ms)
        importCounts.push(`${o.imported} imported / ${o.shown} shown`)
        // Deliberately no settling wait: the switch happens right after opening,
        // which is exactly when the stutter is reported.
        cold.push(await switchToNext(page))
      }

      // ---------- WARM: repeated switches in one session ----------
      const warm: number[] = []
      for (let i = 0; i < DOCS; i++) {
        warm.push(await switchToNext(page))
      }

      const perf = await collectRendererProbe(page)
      const mainSamples = await collectMainProbe(electronApp)

      console.log('\n\n================ PERF REPORT ================')
      console.log('scenario: open folder -> immediately switch files')
      console.log(
        REAL_FOLDER
          ? `folder: REAL ${folder}`
          : `fixture: ${DOCS} root docs, ${SUBDIR_DOCS} per level x ${SUBDIR_DEPTH} levels`,
      )
      console.log('docs imported:', expected)
      console.log('\n--- OPEN folder (resolve -> import -> start watcher -> render) ---')
      console.log('  ' + summarize(opens))
      console.log('  raw:', opens.map((v) => v.toFixed(0) + 'ms').join(', '))
      console.log('  per round:', importCounts.join(' | '))
      console.log('\n--- COLD switch (reload -> open -> switch at once) ---')
      console.log('  ' + summarize(cold))
      console.log('  raw:', cold.map((v) => v.toFixed(0) + 'ms').join(', '))
      console.log('\n--- WARM switch (repeated, same session) ---')
      console.log('  ' + summarize(warm))
      console.log('  raw:', warm.map((v) => v.toFixed(0) + 'ms').join(', '))

      console.log('\n--- renderer: click -> painted frame (INP-like) ---')
      console.log('  ' + summarize(perf.switches.map((s) => s.painted - s.t0)))
      console.log('--- renderer: long tasks (>50ms) ---')
      const lts = perf.longTasks.filter((t) => t.dur > 50)
      console.log('  count:', lts.length, ' ' + summarize(perf.longTasks.map((t) => t.dur)))
      for (const t of lts.sort((a, b) => b.dur - a.dur).slice(0, 10)) {
        console.log(`    ${t.dur.toFixed(1)}ms at t=${(t.start / 1000).toFixed(2)}s`)
      }
      console.log('--- IPC documents.get ---')
      console.log('  ' + summarize(perf.ipc.map((s) => s.dur)))

      reportMainLag(mainSamples)
      console.log('\n=============================================\n')
    } finally {
      await closeApp(handle)
    }
  })
})
