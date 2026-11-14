// e2e/residue-gate/residue-gate.e2e.spec.ts
//
// Residue gate. This single test lives in its OWN project (see playwright.config.ts:
// `residue-gate`) and is wired as the `teardown` of EVERY temp-allocating project
// (the set is derived by e2e/guards/e2e-parallelism.test.ts), so Playwright runs it
// automatically AFTER all of those
// projects' tests have finished — and it produces a REAL failed test (not merely a
// run-level error that JUnit would record as "not part of any test").
//
// What it audits: the run-scoped, on-disk registry that `e2e/helpers/temp.ts` writes
// for every directory the harness allocates. A crashed worker loses its in-memory
// `tracked` set, but its allocations are still on disk, so this gate can catch leaks
// that no per-test hook could report.
//
// The audit logic (readResidueRegistry / findResidue / cleanupResidue) lives in
// e2e/helpers/temp.ts and is unit-tested in e2e/helpers/temp.test.ts — including a
// deliberately leaked path, which is the permanent form of "make the gate go red".
// This spec only orchestrates: EVIDENCE first, then CLEANUP, then ASSERT, so a
// clean-up can never overwrite the evidence before the assertion sees it.
import { test, expect } from '@playwright/test'
import {
  RESIDUE_REGISTRY_DIR,
  RESIDUE_GRACE_MS,
  readResidueRegistry,
  findResidue,
  cleanupResidue,
} from '../helpers/temp'

test('no leftover temp directories after this e2e run', async () => {
  const allocated = readResidueRegistry(RESIDUE_REGISTRY_DIR)

  // 1. EVIDENCE — which registered paths survived the deleter's full window.
  const leftovers = await findResidue(allocated, { graceMs: RESIDUE_GRACE_MS })

  // 2. CLEANUP — remove the leaked directories so a failing run never leaves a
  //    mess behind. The registry itself is NOT deleted here: `global-setup.ts`
  //    wipes it once at the start of the next run. Deleting it from the gate would
  //    race a still-running worker's recordAllocation (silently losing evidence)
  //    and would make a retry face an empty register and pass vacuously.
  cleanupResidue(leftovers)

  // 3. ASSERT — a real failed test, recorded by JUnit/CI as `failed`.
  expect(
    leftovers,
    `e2e left behind temp directories that were never reclaimed by the harness or ` +
      `the app (a closeApp force-kill, or the app's quit-time cleanup failing?). ` +
      `Leaked paths:\n${leftovers.join('\n')}`,
  ).toEqual([])
})
