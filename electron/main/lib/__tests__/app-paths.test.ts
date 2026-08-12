import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ appPath: '/fake/app/path' }))

vi.mock('electron', () => ({
  app: { getAppPath: () => h.appPath },
}))

// The module reads VITE_DEV_SERVER_URL at import time, so each case must reset
// the module registry and set the env BEFORE importing.
async function loadAppPathsWithEnv(value: string | undefined) {
  vi.resetModules()
  if (value === undefined) delete process.env['VITE_DEV_SERVER_URL']
  else process.env['VITE_DEV_SERVER_URL'] = value
  return import('../app-paths.js')
}

describe('app-paths — runtime path constants', () => {
  beforeEach(() => {
    delete process.env['VITE_DEV_SERVER_URL']
  })

  it('derives MAIN_DIST / RENDERER_DIST from app.getAppPath()', async () => {
    const { MAIN_DIST, RENDERER_DIST } = await loadAppPathsWithEnv(undefined)
    expect(MAIN_DIST).toBe(join(h.appPath, 'dist-electron'))
    expect(RENDERER_DIST).toBe(join(h.appPath, 'dist', 'renderer'))
  })

  it('reads VITE_DEV_SERVER_URL from the environment when set', async () => {
    const { VITE_DEV_SERVER_URL } = await loadAppPathsWithEnv('http://localhost:5174')
    expect(VITE_DEV_SERVER_URL).toBe('http://localhost:5174')
  })

  it('falls back to an empty string when VITE_DEV_SERVER_URL is unset', async () => {
    const { VITE_DEV_SERVER_URL } = await loadAppPathsWithEnv(undefined)
    expect(VITE_DEV_SERVER_URL).toBe('')
  })
})
