# ADR-0027: Parallelize e2e — adaptive `workers` + CI job sharding

- **Status:** Accepted

## Context

The e2e suite (`playwright.config.ts`) ran with `fullyParallel: false` and `workers: 1`, and the
config comments claimed two reasons for the serial limit:

1. "Electron app is a single shared instance per worker"
2. "one Electron app at a time keeps the single-instance lock happy"

Both are **obsolete**. Investigation showed:

- Every test launches its **own** Electron instance with a **private `--user-data-dir`**
  (`e2e/helpers/launch.ts` → `mkTempDir('markflow-e2e-')` + `--user-data-dir`). State never
  leaks between tests; there is no "single shared instance per worker".
- The single-instance lock is **never acquired in the e2e path**. `electron/main/index.ts` does
  `app.isPackaged ? app.requestSingleInstanceLock() : true`, and e2e always runs in DEV mode
  (`VITE_DEV_SERVER_URL` set ⇒ `app.isPackaged === false`), so the lock is unconditionally skipped.
- `e2e/specs/multi-instance.e2e.spec.ts` is a regression guard proving two Electron instances coexist.

Measured on a local multi-core Windows machine (`e2e-app` project, 167 passed / 20 skipped):

| Mode                               | Wall-clock  | Failures |
| ---------------------------------- | ----------- | -------- |
| Serial (sum of per-test durations) | ≈ 16.7 min  | —        |
| `workers=4`                        | **4.4 min** | 0        |

→ ≈ **3.8× speedup** at 4 workers, with zero failures in the sample. The suite is therefore highly
parallelizable. The user wants both the **local feedback loop** and **CI** to be faster.

Two suites must never run concurrently:

- `e2e-clipboard` writes the **real system clipboard** (Playwright cannot intercept it; tests verify
  a genuine write and restore it afterwards). Concurrent writes would stomp each other and break the
  "put it back" invariant.
- `e2e-perf-gate` / `e2e-perf-diag` assert **hard timing thresholds**; parallelism would corrupt the
  measurements.

One framework property was believed to shape the whole design: **Playwright runs projects
sequentially** (each project is its own phase), so an invocation naming several projects runs them
one after another. The measurement offered for it — "two 4s specs in two projects took 8.4s of wall
clock, not 4s" — was read as sequential, but 8.4s is what CONCURRENT execution plus start-up
overhead looks like.

**Corrected 2026-11-06 by measurement:** Playwright schedules the projects of one invocation
CONCURRENTLY, sharing the global worker budget. Three specs in two projects ran on three workers
and finished in 12.7s of wall clock while their own durations summed to 21.1s — they overlapped.
`workers: 1` caps concurrency _within_ a project only.

Consequence: a project that must not share the machine needs its OWN invocation. The perf gate
measured 1602ms against its 1500ms threshold while sharing an invocation with `e2e-app` (297
tests), and 712ms in an invocation of its own — the gate was timing the machine, not the app.
`npm run e2e:full` and the CI serial job now run the perf gate separately (see
`playwright.config.ts`'s layer-2 note and `e2e/guards/e2e-parallelism.test.ts`). The threshold was
NOT relaxed: the app is still ~3x faster than the frozen 2644ms baseline.

## Decision

1. **Adaptive `workers` budget in `playwright.config.ts`** (replaces the hard `workers: 1`) — this is
   the **single source of truth** for the worker count, in CI and locally:

   ```ts
   workers: Math.max(1, Math.min(availableParallelism(), 8) - 1)
   ```

   - Local (many cores) → up to **7** workers.
   - CI (2-core runner) → **1** (the formula self-limits; CI never over-subscribes the host).
   - `availableParallelism()` rather than `cpus().length`: it honours the CPU affinity mask and the
     container's cgroup CPU quota, so a runner limited to fewer cores than its host is not
     over-subscribed — `cpus().length` reports the HOST's core count there.
   - `fullyParallel: false` is **kept**: tests within a file run serially, parallelism is across
     files via the worker pool — exactly the safe shape.
   - The CI shard command does **NOT** pass `--workers`, so it can never override this formula.

2. **Per-project `workers: 1` caps** on `e2e-clipboard`, `e2e-perf-gate`, `e2e-perf-diag` so the
   destructive / timing-sensitive suites stay serial regardless of the global budget. (`e2e-app`
   inherits the global budget.)
3. **CI sharding** in `.github/workflows/ci.yml`: split the single `e2e` job into
   - `e2e-app-shard`: a 4-way matrix (`shard: [1,2,3,4]`), each running
     `npx playwright test --project=e2e-app --shard=${{matrix.shard}}/${{strategy.job-total}}` under
     `xvfb-run`. Parallelism comes from the **N shards on N runners**, not from `--workers` inside one
     job; the command deliberately omits `--workers`, so the worker count is driven solely by the
     config's adaptive formula (point 1).
   - `e2e-serial`: runs `e2e-clipboard` + `e2e-perf-gate` on its own runner, each in its own
     `playwright test` invocation (amended 2026-11-06 — the perf gate must not share the machine).
   - `release.needs` updated to `[build, ut, e2e-app-shard, e2e-serial, quality, version]`.
4. **The workflow holds no worker count.** `ci.yml` describes only what CI does — sharding, job
   boundaries, the runner-specific Electron / chrome-sandbox notes — and points at
   `playwright.config.ts` for the concurrency number. A concrete count in the workflow would be a
   second copy of the truth that silently drifts when the config changes.
5. The obsolete config comments are replaced with the corrected rationale (this ADR is cited inline).

## Considered Options

- **Keep `workers: 1` (status quo):** rejected — built on a false premise; leaves ~17 min on the table.
- **Bump the global `workers` only (no sharding):** rejected as the sole fix — on CI's 2-core runner a
  global bump shares one machine with the clipboard/perf projects and can only reach ~2×, and it would
  parallelize `e2e-clipboard` unless explicitly capped (it is now capped, but the ceiling is still the
  single runner).
- **CI sharding only (no adaptive `workers`):** rejected as the sole fix — helps CI but does nothing for
  the local feedback loop, which was an explicit requirement.
- **Adaptive `workers` only (no sharding):** partially rejected — fixes local, and on CI gives 1 worker
  (safe but no CI speedup since the 2-core formula floors at 1).
- **Both, with a hardcoded `--workers=2` in CI to "fill the 2 cores" (rejected):** briefly considered,
  but it overrides — and thus contradicts — the adaptive formula that is the stated single source of
  truth, and hardcodes a value that was never measured on the 2-core runner. The chosen design keeps
  the formula authoritative and gets CI speedup from sharding instead.
- **Both (chosen):** local gets adaptive parallelism; CI gets true machine-level parallelism
  (shards). The shard command does NOT hardcode `--workers` — the config's adaptive formula stays the
  single source of truth, so CI resolves to 1 worker per shard on the 2-core runner while the 4 shards
  in parallel provide the speedup.

## Consequences

- **Positive:** local `e2e-app` drops from ~17 min toward ~4–5 min (measured at `workers=4` → 4.4 min);
  CI `e2e-app` runs as 4 parallel jobs (one per shard, each on its own runner), each using the config's
  adaptive worker count (1 on the 2-core CI runner), instead of one serial ~17-min job.
- **Positive:** clipboard / perf suites remain provably serial (per-project `workers: 1`), so the real
  clipboard and timing gates are never corrupted.
- **Positive:** each shard job is independent, so a flaky/hung shard cannot take down the others, and
  retries are isolated per shard.
- **Positive:** the worker count has exactly one knob — the config formula — so it cannot drift between
  local and CI due to a stray CLI flag, and the workflow cannot rot into a stale comment.
- **Cost (accepted):** sharding multiplies the fixed setup — every shard job re-runs `npm ci` +
  `npm run build` + `npx playwright install --with-deps` + Electron cache restore. This is the
  explicit "setup tax" traded for the wall-clock win.
- **Guard rail:** `e2e/guards/e2e-parallelism.test.ts` fails a unit test (not an opaque e2e timeout)
  if the clipboard / perf projects lose their `workers: 1` cap, if `e2e-app` gains a project-level cap,
  if the global budget is hardcoded, if a CI step starts passing `--workers`, if the projects CI
  runs and the projects `npm run e2e:full` runs drift apart, or if the perf gate stops having an
  invocation of its own (amended 2026-11-06).
- **Risk — the caps are unmeasured:** the `8` cap and the "−1" headroom are **not** measured beyond the
  `workers=4` datapoint; they are reasonable RAM/OS guards, not validated optima. Re-measure locally
  (`--workers=8`) before treating 7 as a tuned value.
- **Risk — the shared Vite dev server under load:** every worker loads the renderer from the ONE dev
  server `global-setup.ts` starts. That held at 4 workers (0 failures in the measurement above), but N
  concurrent first-loads can race Vite's on-demand dependency optimization. If a startup flake appears
  at higher worker counts, pre-warm the dev server or lower the cap.
- **Risk — CI worker count tracks the runner:** because the shard command omits `--workers`, each
  shard's worker count is whatever the config formula resolves to on that runner (1 today). If GitHub
  upgrades `ubuntu-latest` to more cores, CI workers per shard rise with it and flake risk may follow —
  revisit then (the config formula is the single knob to turn).
- **Constraint:** the safety argument has two halves — the per-project `workers: 1` caps cover
  concurrency _within_ a project, and the perf gate's OWN invocation covers concurrency _between_
  projects. **Amended 2026-11-06:** the second half used to be "Playwright's sequential project
  scheduling", which turned out to be false (projects of one invocation run concurrently). The
  perf gate therefore runs as a separate `playwright test` invocation — the change this entry
  already anticipated ("If Playwright ever parallelised projects, the clipboard and perf suites
  would need their own invocations; that is the change to make then"). The clipboard project stays
  in the bulk invocation: it is destructive but not timing-sensitive, and no other project writes
  the system clipboard.
- **Constraint:** the shard count (`4`) is hand-picked for the current ~37-spec `e2e-app` and the
  2-core runner; the per-shard worker count is intentionally left to the config formula, not pinned
  here. Revisit either if the spec count or runner shape changes substantially.
