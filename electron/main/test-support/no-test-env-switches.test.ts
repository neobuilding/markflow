// @vitest-environment node
//
// Guard test (not a helper): no production file may read a test-only environment variable.
// Such a switch makes the main process behave differently "under test", so the thing the
// suite exercises is not the thing users run — and the divergence is invisible from the
// outside. The alternative that replaced them (see ADR 0016) is honest input recognition:
// `--user-data-dir` is a real Chromium switch any caller may pass, so honoring it costs
// nothing and needs no special mode.
//
// This file names the banned variables, so it exempts itself from the scan below.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const SELF = fileURLToPath(import.meta.url)

/** Variables that used to let production code sniff out "am I being tested?". */
const BANNED_SWITCHES = ['MARKFLOW_E2E', 'MARKFLOW_CLEANUP_DEBUG']

/** Test files may legitimately *mention* these names to explain why they are gone. */
const IS_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(full)) out.push(full)
  }
  return out
}

describe('shipped code carries no test-only switch', () => {
  it('injected nowhere in electron/, src/ or the e2e harness', () => {
    const offenders: string[] = []

    // e2e/ is scanned too: the switch was originally injected from the harness, so a guard
    // that only watched production would have let exactly this come back.
    for (const root of [
      join(REPO_ROOT, 'electron'),
      join(REPO_ROOT, 'src'),
      join(REPO_ROOT, 'e2e'),
    ]) {
      for (const file of collectSources(root)) {
        if (join(file) === SELF) continue
        if (IS_TEST_FILE.test(file)) continue
        const text = readFileSync(file, 'utf-8')
        for (const name of BANNED_SWITCHES) {
          if (text.includes(name)) offenders.push(`${file} -> ${name}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
