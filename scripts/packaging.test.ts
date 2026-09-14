// Guards the packaging decisions from ADR-0015 that live ONLY in config — there is no
// runtime code to unit-test, so a well-meaning cleanup could silently undo them:
//   - `node_modules` must stay OUT of `app.asar`. Both builds are fully bundled by Vite
//     (`dist/electron/index.js` has no bare `require()` except Node builtins), so
//     shipping `node_modules` duplicated ~92 MB of already-bundled dependencies into
//     the asar.
//   - `dist/electron` + `dist/renderer` must stay IN — they are the entire app payload
//     (11.8 MB) now that `node_modules` is excluded.
//
// These are string assertions on purpose: electron-builder.json5 is JSON5 (comments +
// unquoted keys), so parsing it would need a JSON5 dependency for no real benefit.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const CONFIG = readFileSync(join(process.cwd(), 'electron-builder.json5'), 'utf-8')

describe('electron-builder packaging config (ADR-0015)', () => {
  it('excludes node_modules from the packaged app', () => {
    expect(CONFIG).toContain("'!node_modules'")
    expect(CONFIG).toContain("'!node_modules/**/*'")
  })

  it('still ships the bundled output and the packaged-app hook', () => {
    expect(CONFIG).toContain("'dist/electron/**/*'")
    expect(CONFIG).toContain("'dist/renderer/**/*'")
    expect(CONFIG).toContain("afterAllArtifactBuild: './scripts/after-all-artifact-build.mjs'")
  })
})
