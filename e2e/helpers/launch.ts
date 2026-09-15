// e2e/helpers/launch.ts
// Shared launch logic for the MarkFlow Electron app under Playwright.
//
// The Vite dev server is started ONCE by the Playwright global setup
// (e2e/global-setup.ts) and shared by every test this avoids the
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

/**
 * A single native confirm-box invocation as seen at the `electron.dialog.showMessageBox`
 * boundary. This is exactly what the OS would render, so it is the faithful thing to
 * assert on for "文案/按钮" (copy / buttons).
 */
export interface ConfirmCall {
  /** Dialog body copy (e.g. the unsaved-changes message). */
  message: string
  /** Optional secondary copy. */
  detail?: string
  /** The buttons array the OS would render, e.g. ['Keep editing', 'Discard']. */
  buttons?: string[]
  /** Index of the default-focused button. */
  defaultId?: number
  /** Index of the Esc/cancel button. */
  cancelId?: number
  /** Dialog type, e.g. 'question'. */
  type?: string
  /** The canned answer the spy auto-picked (1 = ok/Discard, 0 = cancel/Keep). */
  response: number
}

/**
 * Spy on the main-process native `electron.dialog.showMessageBox` so e2e tests can BOTH
 * assert the confirm box's copy/buttons AND auto-answer it.
 *
 * Playwright cannot click native OS dialog buttons, so the production `dialog:confirm`
 * handler (electron/main/handlers/dialog.ts) would otherwise block the quit until the
 * 15s closeApp timeout. Instead of stubbing the IPC handler with a fixed boolean, this
 * replaces `dialog.showMessageBox` with a recorder that:
 *   - captures the exact options the production code would pass to the OS box
 *     (message, buttons array, defaultId, cancelId, type);
 *   - returns a canned `response` (default 1 = Discard) so the app quits gracefully.
 *
 * The production `dialog:confirm` handler is left UNTOUCHED and still runs, so the real
 * dirty-quit flow (tryCloseWorkspace → app:quit-pending → discard → closeWorkspace +
 * allowQuit) is fully exercised; only the native button render is skipped, which
 * Playwright cannot reach anyway.
 */
export async function installConfirmSpy(
  handle: AppHandle,
  opts: { defaultResponse?: 0 | 1 } = {},
): Promise<void> {
  const defaultResponse = opts.defaultResponse ?? 1
  await handle.electronApp.evaluate((electron, defaultResponse) => {
    const dialog = (electron as any).dialog
    const g = globalThis as any
    g.__mf_confirm_calls = g.__mf_confirm_calls ?? []
    // Replace the native box with a recorder + auto-answer. We deliberately do NOT call
    // the real showMessageBox: it would open an OS modal Playwright cannot click, which
    // would block until the 15s closeApp timeout + force-kill.
    dialog.showMessageBox = async (o: any) => {
      g.__mf_confirm_calls.push({
        message: o?.message,
        detail: o?.detail,
        buttons: o?.buttons,
        defaultId: o?.defaultId,
        cancelId: o?.cancelId,
        type: o?.type,
        response: defaultResponse,
      })
      return { response: defaultResponse, checkboxChecked: false }
    }
  }, defaultResponse)
}

/** Read the native confirm invocations recorded by installConfirmSpy. */
export async function getConfirmCalls(handle: AppHandle): Promise<ConfirmCall[]> {
  return handle.electronApp.evaluate(() => (globalThis as any).__mf_confirm_calls ?? [], undefined)
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
    // --no-sandbox: required for Electron to launch under the non-root CI runner
    // (GitHub Actions ubuntu-latest). Without it, Electron's chrome-sandbox helper
    // aborts because it expects root:4755 ownership, which `npm ci` never sets and
    // the runner does not grant sudo for. This flag is ONLY used by the e2e path
    // (npm run e2e); production builds go through electron-builder and are unaffected.
    args: [
      join(PROJECT_ROOT, 'dist', 'electron', 'index.js'),
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
    ],
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
 *
 * Before closing, the unsaved-changes confirm (a native electron.dialog.showMessageBox
 * handled in the MAIN process via the `dialog:confirm` IPC) is auto-answered as
 * Discard in the main process see the inline note below. Playwright cannot click
 * native OS dialog buttons, so a dirty workspace would otherwise block the graceful
 * quit until CLOSE_TIMEOUT_MS and force-kill the tree (noisy + ~15s slower per dirty
 * test, and it skips the real graceful-quit + folder-watcher teardown). Auto-answering
 * still drives the REAL quit flow and only bypasses the native button render.
 */
export async function closeApp(handle: AppHandle): Promise<void> {
  const CLOSE_TIMEOUT_MS = 15_000
  let timedOut = false
  // process() can throw (TypeError: reading '_object') if the ElectronApplication
  // has already been torn down e.g. when a test drove the app to exit on its own
  // (clean quit path) and then afterEach calls closeApp. Resolve the pid defensively
  // so closeApp is a no-op for an already-exited app instead of crashing the test.
  let pid: number | undefined
  try {
    pid = handle.electronApp.process()?.pid
  } catch {
    /* app already exited nothing to clean up */
    return
  }
  // Auto-answer the app's unsaved-changes confirm as Discard BEFORE the graceful
  // close, so a dirty workspace quits cleanly instead of hanging on the native
  // dialog until the 15s timeout. The confirm is a native electron.dialog.showMessageBox
  // (electron/main/handlers/dialog.ts) invoked from the renderer over the `dialog:confirm`
  // IPC; Playwright cannot click native OS dialog buttons, so we spy `showMessageBox`
  // (installConfirmSpy) to record + auto-answer. This is the same mechanism
  // e2e/specs/quit-unsaved-regression.e2e.spec.ts uses (there answering `false` to keep
  // editing); here we answer `1` (Discard).
  //
  // Crucially this does NOT bypass the dirty scenario: tryCloseWorkspace() still takes
  // its dirty branch, sends app:quit-pending (disarming the 5s safety net), and after the
  // (auto-answered) discard calls closeWorkspace() + allowQuit() so the app exits gracefully
  // and `will-quit` tears down the folder watcher. Only the native button render is skipped,
  // which Playwright cannot reach anyway. The 15s timeout + force-kill below remain the
  // ultimate fallback for a genuinely unresponsive app.
  try {
    await installConfirmSpy(handle, { defaultResponse: 1 })
  } catch {
    /* app already gone; the close path below tolerates it */
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
    // to clean up don't report this as a timeout
    const msg = (err as Error)?.message ?? String(err)
    if (/Cannot read properties of undefined|_object|Target page.*closed/i.test(msg)) {
      alreadyClosed = true
    }
    if (!alreadyClosed) {
      // The close failed or timed out. Force-kill the process TREE so no zombie
      // Electron child (GPU/renderer/utility) lingers killing only the main PID
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
 * On POSIX the SAME orphaning happens (children reparent to init), so we kill the
 * direct children first via `pkill -P` (exists on macOS and Linux) and then SIGKILL
 * the main PID. Order matters: kill children BEFORE the main, else they reparent and
 * `-P` no longer matches them. `pkill` missing is a no-op; we still SIGKILL the main.
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
      // Kill direct children (zygote/gpu/utility) FIRST, then the main PID, so the
      // children don't get reparented to init before we can target them by parent.
      // When the zygote dies, its renderer children exit too this one-level walk plus
      // the cascade mirrors Windows `taskkill /T` (transitive tree kill).
      try {
        spawnSync('pkill', ['-9', '-P', String(pid)], { stdio: 'ignore' })
      } catch {
        /* pkill unavailable (unexpected on macOS/Linux) */
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already dead */
      }
    }
  } catch {
    // ignore nothing more we can do
  }
}
