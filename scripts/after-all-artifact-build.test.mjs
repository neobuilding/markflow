// Unit tests for the electron-builder `afterAllArtifactBuild` hook.
//
// The hook is a pure reporter, so its contract is small but strict: it must name
// `release/` (the whole point of the hook — no more hunting for the packaged app),
// list every artifact electron-builder produced, and NEVER throw. A throwing hook
// aborts packaging at the very end, after the artifacts were already built.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { relative, join } from 'node:path'
import { afterAllArtifactBuild } from './after-all-artifact-build.mjs'

// Capture everything the hook prints so we can assert on the announced paths.
function captureLog() {
  const lines = []
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '))
  })
  return lines
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('afterAllArtifactBuild', () => {
  it('announces the release dir and every artifact path', async () => {
    const lines = captureLog()
    const zip = join(process.cwd(), 'release', 'markflow-2.2.0-win.zip')
    const unpacked = join(process.cwd(), 'release', 'win-unpacked')

    await afterAllArtifactBuild({ artifactPaths: [zip, unpacked] })

    const out = lines.join('\n')
    expect(out).toContain('release/')
    expect(out).toContain(relative(process.cwd(), zip))
    expect(out).toContain(relative(process.cwd(), unpacked))
    expect(out).toContain(join(process.cwd(), 'release'))
  })

  it('still names release/ when nothing was produced', async () => {
    const lines = captureLog()

    await afterAllArtifactBuild({ artifactPaths: [] })

    const out = lines.join('\n')
    expect(out).toContain('release/')
    expect(out).toContain(join(process.cwd(), 'release'))
  })

  it('never throws when the build result is missing or empty', async () => {
    captureLog()
    // electron-builder always passes a result, but a hook that explodes on an
    // unexpected shape would take the whole `npm run dist` down with it.
    await expect(afterAllArtifactBuild(undefined)).resolves.toBeUndefined()
    await expect(afterAllArtifactBuild({})).resolves.toBeUndefined()
  })

  it('is exposed as the module default export so electron-builder can load it', async () => {
    captureLog()
    // app-builder-lib resolves the hook via dynamicImportMaybe and calls the
    // default export, so BOTH the named and the default export must be the fn.
    const mod = await import('./after-all-artifact-build.mjs')
    expect(mod.default).toBe(afterAllArtifactBuild)
  })
})
