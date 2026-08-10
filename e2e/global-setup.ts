// e2e/global-setup.ts
// Starts the Vite dev server ONCE for the whole e2e run and publishes its URL
// via MARKFLOW_DEV_URL so every test can launch Electron against it.
import { spawn, ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { writeFileSync, existsSync, unlinkSync, accessSync } from 'node:fs'

const PROJECT_ROOT = join(__dirname, '..')
const DEV_SERVER_URL = 'http://localhost:5174'
const DEV_URL_FILE = join(__dirname, '.dev-url')

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

export default async function globalSetup(): Promise<() => Promise<void>> {
  const vite = getViteBin()
  devServer = spawn(vite.command, [...vite.args, '--port', '5174', '--strictPort'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  devServer.stderr?.on('data', (d) => {
    const s = d.toString()
    if (/error|fail|cannot/i.test(s)) process.stderr.write(`[vite] ${s}`)
  })

  await waitForServer(DEV_SERVER_URL, 120_000)
  await waitForMainEntry(120_000)

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
