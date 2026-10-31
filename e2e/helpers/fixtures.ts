// The e2e `test` object, extended with the repo's own options.
//
// One option today: `clipboardE2e`. The specs that write the REAL system clipboard are destructive
// by nature (see helpers/clipboard.ts), so they belong to the dedicated `e2e-clipboard` project in
// playwright.config.ts, which is the only place that sets this option. Every other project leaves
// it false and the specs skip themselves — so `npm run e2e:app` never touches the user's clipboard.
//
// It is a fixture option rather than an environment variable on purpose: what a run is allowed to
// do becomes visible in the config, next to the project that allows it, instead of in an invisible
// variable a developer has to know about (and which the app itself must never sniff — ADR 0016).
//
// Specs that never touch the clipboard keep importing `test` from '@playwright/test'.
import { test as base } from '@playwright/test'

export interface ClipboardOptions {
  /** True only in the `e2e-clipboard` project (see playwright.config.ts). */
  clipboardE2e: boolean
}

export const test = base.extend<ClipboardOptions>({
  // `{ option: true }` makes this settable from a project's `use` in the config.
  clipboardE2e: [false, { option: true }],
})

export { expect } from '@playwright/test'
