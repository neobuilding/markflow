// e2e/helpers/launch.ts
// Shared launch logic for the MarkFlow Electron app under Playwright.
//
// The Vite dev server is started ONCE by the Playwright global setup
// (e2e/global-setup.ts) and shared by every test — this avoids the
// "port 5174 already in use" failures we hit when each test spawned its own
// server. launchApp() just launches a fresh Electron instance pointed at that
// shared dev server via VITE_DEV_SERVER_URL.
//
// Each test uses its OWN temporary user-data-dir so the document store is
// isolated (prevents the file_path collision when multiple memory-only
// drafts are created across tests, and keeps tests from polluting real data).
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { _electron as electron, ElectronApplication, Page } from 'playwright'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEV_URL_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev-url')

export interface AppHandle {
  electronApp: ElectronApplication
  page: Page
  userDataDir: string
}

/** Launch a fresh Electron instance against the shared Vite dev server. */
export async function launchApp(): Promise<AppHandle> {
  // Prefer the env var (inherited from globalSetup); fall back to the marker file.
  let devUrl = process.env.MARKFLOW_DEV_URL
  if (!devUrl && existsSync(DEV_URL_FILE)) {
    devUrl = readFileSync(DEV_URL_FILE, 'utf-8').trim()
  }
  if (!devUrl) {
    throw new Error('MARKFLOW_DEV_URL is not set — did the Playwright globalSetup run?')
  }

  // Isolated user data dir per test for a clean document store each time.
  const userDataDir = mkdtempSync(join(tmpdir(), 'markflow-e2e-'))

  const electronApp = await electron.launch({
    args: [join(PROJECT_ROOT, 'dist-electron', 'index.js'), `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devUrl,
      MARKFLOW_E2E: '1',
    },
    timeout: 60_000,
  })

  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { electronApp, page, userDataDir }
}

/** Wait for the React app root to mount and render something meaningful. */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector('#root', { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#root')
      return !!root && root.childElementCount > 0
    },
    { timeout: 30_000 },
  )
  // Pin the UI language to English so assertions are stable regardless of
  // the host system's locale (the app follows navigator.language by default
  // and would render Chinese on a Chinese host, breaking text-based matches).
  await forceEnglish(page)
}

/**
 * Switch the running app to the English locale via the same store action the
 * language menu uses, so i18next + React re-render with the English strings.
 */
export async function forceEnglish(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    if (w.__uiStore && w.__uiStore.getState().language !== 'en') {
      w.__uiStore.getState().setLanguage('en')
    }
  })
}

/**
 * Tear down the Electron app (Vite is torn down by the global teardown).
 *
 * Tries a graceful close first; if it does not resolve within CLOSE_TIMEOUT_MS
 * (the renderer may be dead/unresponsive, the quit-guard's 5s safety net may
 * not have fired yet, etc.), force-kills the Electron process so no zombie
 * window ever remains after a run. Failures are surfaced as a warning rather
 * than silently swallowed, so a flaky close is visible without failing the test.
 */
export async function closeApp(handle: AppHandle): Promise<void> {
  const CLOSE_TIMEOUT_MS = 15_000
  let timedOut = false
  // process() can throw (TypeError: reading '_object') if the ElectronApplication
  // has already been torn down — e.g. when a test drove the app to exit on its own
  // (clean quit path) and then afterEach calls closeApp. Resolve the pid defensively
  // so closeApp is a no-op for an already-exited app instead of crashing the test.
  let pid: number | undefined
  try {
    pid = handle.electronApp.process()?.pid
  } catch {
    /* app already exited — nothing to clean up */
    return
  }
  // Similarly, electronApp.close() may throw synchronously on an already-closed
  // app; treat that as success (graceful close is already done).
  let alreadyClosed = false
  try {
    await Promise.race([
      handle.electronApp.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          timedOut = true
          reject(new Error('electronApp.close() timed out'))
        }, CLOSE_TIMEOUT_MS),
      ),
    ])
  } catch (err) {
    // If the app already exited (process gone), close() threw but there's nothing
    // to clean up — don't report this as a timeout.
    const msg = (err as Error)?.message ?? String(err)
    if (/Cannot read properties of undefined|_object|Target page.*closed/i.test(msg)) {
      alreadyClosed = true
    }
    if (!alreadyClosed) {
      // The close failed or timed out. Force-kill the process TREE so no zombie
      // Electron child (GPU/renderer/utility) lingers — killing only the main PID
      // orphan-reparents the children to explorer/init on Windows and they keep
      // running, which previously left 4+ residual electron.exe processes after a
      // run and stalled the Playwright worker teardown.
      killProcessTree(pid)
      if (timedOut) {
        console.warn(
          `[e2e] closeApp: graceful close timed out after ${CLOSE_TIMEOUT_MS}ms; ` +
            `force-killed the Electron process tree. Underlying error: ${msg}`,
        )
      }
    }
  }
}

/**
 * Kill a process AND all its descendants. On Windows, SIGKILL from Node only
 * terminates the target PID, leaving child processes (Electron's GPU/renderer/
 * utility children) orphaned. `taskkill /T /F` walks the tree and kills them all.
 * On POSIX, fall back to a simple SIGKILL (process groups are usually clean there).
 */
function killProcessTree(pid?: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      // /T = kill child processes of the given PID; /F = force.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      })
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already dead */
      }
    }
  } catch {
    // ignore — nothing more we can do
  }
}
