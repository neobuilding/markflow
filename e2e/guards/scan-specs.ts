// Shared scanning helpers for the e2e guards.
//
// Every guard needs the same answer to the same question: "which spec files does this directory
// contain, recursively?" Answering it three times, in three slightly different ways, is how a guard
// ends up scanning one level while its neighbour scans the whole tree — and a spec dropped into a
// subdirectory then slips past the check that was supposed to catch it.
//
// So there is exactly ONE implementation here, and all guards use it.
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** The file shape Playwright collects: `<name>.e2e.spec.ts`. */
export const SPEC_FILE_RE = /\.e2e\.spec\.ts$/

/**
 * Playwright's DEFAULT testMatch also matches `*.spec.ts` / `*.test.ts` — and the bare `spec.ts` /
 * `test.ts`. A file of that shape inside a project directory would be collected by accident, which
 * is why the guards police it (ADR-0034).
 */
export const STRAY_TEST_FILE_RE = /(^|\.)(spec|test)\.[cm]?[jt]sx?$/

/**
 * The ONE recursive walk behind both scanners. Two copies of `walk` was how the guards ended up
 * disagreeing about depth in the first place; the only difference between them is which file names
 * they accept.
 */
function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && accept(entry.name)) out.push(resolve(full))
    }
  }
  visit(dir)
  return out.sort()
}

/** Recursively collect the spec files under a directory as absolute, sorted paths. */
export function specFilesUnder(dir: string): string[] {
  return walk(dir, (name) => SPEC_FILE_RE.test(name))
}

/**
 * The files under a directory that Playwright's default testMatch would collect but that are NOT
 * `<name>.e2e.spec.ts`, reported relative to `root`.
 */
export function strayTestFilesUnder(root: string, dir: string): string[] {
  return walk(dir, (name) => STRAY_TEST_FILE_RE.test(name) && !SPEC_FILE_RE.test(name)).map(
    (file) => relative(root, file),
  )
}
