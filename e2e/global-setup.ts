// e2e/global-setup.ts
// Starts the Vite dev server ONCE for the whole e2e run and publishes its URL
// via MARKFLOW_DEV_URL so every test can launch Electron against it.
import { spawn, spawnSync, ChildProcess } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, existsSync, unlinkSync, accessSync } from 'node:fs'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEV_SERVER_URL = 'http://localhost:5174'
const DEV_URL_FILE = join(dirname(fileURLToPath(import.meta.url)), '.dev-url')

function getViteBin(): { command: string; args: string[] } {
  // Resolve the local Vite JS entry so we don't depend on `npx` shell behaviour
  // or a `.bin/vite` shell script (which doesn't spawn directly on Windows).
  const viteJs = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  try {
    accessSync(viteJs)
    return { command: process.execPath, args: [viteJs] }
  } catch {
    return { command: 'npx', args: ['vite'] }
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Vite dev server did not start within ${timeoutMs}ms at ${url}`)
}

async function waitForMainEntry(timeoutMs: number): Promise<void> {
  const entry = join(PROJECT_ROOT, 'dist-electron', 'index.js')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await import('node:fs/promises').then((fs) => fs.access(entry))
      return
    } catch {
      // not compiled yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Electron main entry not built in time: ${entry}`)
}

let devServer: ChildProcess | null = null

/**
 * Fail FAST if the Electron binary cannot be executed. Without this guard the
 * error surfaces later inside every spec's `electron.launch()` (via
 * test.beforeEach), so all N cases fail (and CI retries them) before the run
 * exits — wasting minutes on an environmental problem, not a test regression.
 * Verifying here aborts the whole run immediately at globalSetup.
 *
 * The probe runs `--version --no-sandbox`: the `--no-sandbox` flag is the same
 * one the real e2e launch uses (see e2e/helpers/launch.ts). It MUST be present
 * here too, otherwise a correct binary would still abort under the non-root CI
 * runner's chrome-sandbox permission check, masking the real "can we spawn
 * Electron at all" question with a sandbox error. `--version` only prints the
 * version string, so the flag is safe (no renderer / no webpage is loaded).
 */
async function verifyElectronBinary(): Promise<void> {
  // The `electron` package's main export is the absolute path to the Electron
  // executable. Importing it (dynamic import works under the ESM loader Playwright
  // uses for setup) gives us the binary to probe without depending on `require`.
  let bin: unknown
  try {
    const mod = await import('electron')
    bin = (mod as { default?: unknown }).default ?? mod
  } catch (err) {
    // Re-throw the original error (preserving its stack/type) with a contextual
    // prefix. We avoid `new Error(msg, { cause })` because the project's TS lib
    // target does not type the `ErrorOptions` argument; assigning `.cause` also
    // fails to type-check on the older lib, so we surface context in the message
    // and keep the source error intact (preserve-caught-error compliant).
    const base = err instanceof Error ? err : new Error(String(err))
    base.message =
      `Could not resolve the Electron binary path via import("electron"): ` + base.message
    throw base
  }
  if (typeof bin !== 'string') {
    throw new Error(
      `Expected import("electron") to yield the binary path string, got ${typeof bin}`,
    )
  }
  const res = spawnSync(bin, ['--version', '--no-sandbox'], { timeout: 60_000 })
  if (res.error || res.status !== 0) {
    const detail = res.error
      ? `${res.error.name}: ${res.error.message}`
      : `exit code ${res.status}, stderr: ${(res.stderr ?? Buffer.alloc(0)).toString().trim()}`
    // Surface the REAL error verbatim (do not hard-code an ETXTBSY assumption —
    // the historical failure was actually a chrome-sandbox SUID permission error
    // under the non-root CI runner, fixed by passing --no-sandbox in launch.ts).
    throw new Error(
      `Electron binary could not be executed during the pre-flight probe ` +
        `(${detail}).\n` +
        `This means every e2e spec would fail to launch Electron. Common causes:\n` +
        `  - chrome-sandbox permission error on a non-root CI runner: ensure ` +
        `--no-sandbox is passed (already done in e2e/helpers/launch.ts and this probe).\n` +
        `  - binary not downloaded/extracted: check the "Cache Electron binaries" ` +
        `step and clear ~/.cache/electron + node_modules/electron/dist if stale.\n` +
        `Raw probe stderr is shown above — use it to diagnose, not a generic message.`,
    )
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const vite = getViteBin()
  devServer = spawn(vite.command, [...vite.args, '--port', '5174', '--strictPort'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Prevent vite-plugin-electron from auto-starting an Electron instance.
      //
      // vite-plugin-electron (simple) builds main+preload in dev, then — via its
      // `:startup` plugin's closeBundle hook — calls triggerStartup(), which with
      // no `onstart` option spawns Electron immediately. That spawn calls
      // require('electron'), and electron/index.js is a LAZY installer: if
      // node_modules/electron/dist/electron is missing it synchronously downloads
      // + extracts (printing "Downloading Electron binary..."). That write races
      // with this very probe (verifyElectronBinary below) → ETXTBSY.
      //
      // e2e does NOT use that auto-started instance: every spec launches its OWN
      // isolated Electron via launchApp() (Playwright _electron.launch with a
      // per-test user-data-dir + MARKFLOW_E2E=1). So suppressing the auto-startup
      // loses nothing the tests rely on, and removes the race entirely.
      //
      // ELECTRON_STARTUP_PREVENT is the official escape hatch (checked at the top
      // of startup() in vite-plugin-electron).
      ELECTRON_STARTUP_PREVENT: '1',
    },
  })
  devServer.stderr?.on('data', (d) => {
    const s = d.toString()
    if (/error|fail|cannot/i.test(s)) process.stderr.write(`[vite] ${s}`)
  })

  await waitForServer(DEV_SERVER_URL, 120_000)
  await waitForMainEntry(120_000)

  // Fail fast on an unexecutable Electron binary BEFORE any spec runs, so an
  // environmental launch failure (e.g. a sandbox permission error or a stale
  // binary) aborts the run immediately instead of failing every case (and its
  // CI retry) one by one.
  await verifyElectronBinary()

  // Share the URL with all tests (file is the reliable channel across
  // Playwright worker processes; env is a best-effort backup).
  writeFileSync(DEV_URL_FILE, DEV_SERVER_URL, 'utf-8')
  process.env.MARKFLOW_DEV_URL = DEV_SERVER_URL

  // Returned teardown runs after all tests finish.
  return async () => {
    if (devServer) {
      try {
        devServer.kill('SIGTERM')
      } catch {
        // ignore
      }
      devServer = null
    }
    if (existsSync(DEV_URL_FILE)) {
      try {
        unlinkSync(DEV_URL_FILE)
      } catch {
        // ignore
      }
    }
  }
}
