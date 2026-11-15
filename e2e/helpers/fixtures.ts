/* eslint-disable react-hooks/rules-of-hooks -- Playwright's fixture callback parameter is named `use`; this module is not a React component or hook. */
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
// This module also owns the DESTRUCTIVE clipboard lifecycle, because getting that order wrong is
// the one failure in the suite that damages something outside the repository: the user's
// clipboard. Six specs used to carry their own copy of "gate → launch → snapshot → restore →
// close", and they had already drifted apart — three skipped before launching the app, three
// launched first and snapshotted conditionally. The lifecycle now exists once, here:
//
//   gate (only the e2e-clipboard project may write the clipboard)
//     → launch the app
//     → snapshot the clipboard
//     → skip if it cannot be restored
//     → run the test
//     → restore the clipboard
//     → close the app
//
// The restore happens while the app is still alive, and the close happens last — so an interrupted
// run can never leave a running app about to overwrite a clipboard that was never put back.
//
// Specs that never touch the clipboard keep importing `test` from '@playwright/test'.
import { test as base } from '@playwright/test'
import { launchApp, closeApp, type AppHandle } from './launch'
import {
  snapshotClipboard,
  restoreClipboard,
  clipboardSkipMessage,
  CLIPBOARD_SPEC_SKIP_REASON,
  type ClipboardSnapshot,
} from './clipboard'

export interface ClipboardOptions {
  /** True only in the `e2e-clipboard` project (see playwright.config.ts). */
  clipboardE2e: boolean
}

export interface ClipboardFixtures {
  /**
   * The running app. Launched, snapshotted, restored and closed by this fixture: a spec that asks
   * for the app cannot skip the clipboard bookkeeping, because the fixture does both or neither.
   */
  clipboardApp: AppHandle
}

/**
 * The default: no project may touch the OS clipboard unless it opts in. Exported so the guard
 * test (e2e/guards/clipboard-project.test.ts) can assert that the default stays "off" — that
 * value is what keeps `npm run e2e:app` away from the user's clipboard.
 */
export const CLIPBOARD_E2E_DEFAULT = false

/**
 * The declaration the fixture actually uses. Exported so the guard can assert the WIRING as data
 * instead of matching a string in this file: a hard-wired `true` here would otherwise leave
 * CLIPBOARD_E2E_DEFAULT green while every project started writing the user's clipboard.
 */
export const CLIPBOARD_OPTION_DECLARATION: [boolean, { option: true }] = [
  CLIPBOARD_E2E_DEFAULT,
  { option: true },
]

export const test = base.extend<ClipboardOptions & ClipboardFixtures>({
  // `{ option: true }` makes this settable from a project's `use` in the config.
  clipboardE2e: CLIPBOARD_OPTION_DECLARATION,

  clipboardApp: async ({ clipboardE2e }, use) => {
    // The destructive gate lives HERE rather than in each spec: a spec that forgot it would write
    // the user's clipboard in whatever project happened to collect it.
    test.skip(!clipboardE2e, CLIPBOARD_SPEC_SKIP_REASON)
    const handle = await launchApp()
    let snap: ClipboardSnapshot | undefined
    try {
      // The snapshot and the restore live in the same fixture as the launch, so a spec cannot ask
      // for the app without also getting the clipboard put back — the two used to be independent
      // steps that a spec could half-do.
      snap = await snapshotClipboard(handle)
      // A clipboard that cannot be read back cannot be put back either. Skipping is the only safe
      // answer: the alternative is destroying whatever the user had copied.
      test.skip(!snap.restorable, clipboardSkipMessage(snap))
      await use(handle)
    } finally {
      // Restore and close run even when the test failed or skipped: a failing test that left the
      // user's clipboard holding a test payload is the worst outcome this suite can produce.
      await restoreClipboard(handle, snap)
      await closeApp(handle)
    }
  },
})
