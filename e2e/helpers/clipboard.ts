// Clipboard helpers for e2e specs.
//
// TWO problems live here, and both are real:
//
// 1. The clipboard is the USER'S data. A copy test has to overwrite it — there is no way to
//    intercept the OS clipboard from Playwright, and mocking it would defeat the very point of
//    `preload-contract` ("no throw" is not a clipboard write). So the rule is: **snapshot before,
//    restore after** (`snapshotClipboard` / `restoreClipboard`), and if the clipboard holds
//    something Electron cannot read back, the test does not touch it at all rather than silently
//    destroying it.
//
//    KNOWN LIMITATION: Electron 44's Clipboard exposes only `read` / `write` / `readText` /
//    `writeText` / `has` / `clear` — `availableFormats()` is gone, so OS-native formats cannot be
//    enumerated or written back. In practice that means **a file copied in Explorer (CF_HDROP) is
//    invisible to `read()`**: such a clipboard looks empty, the snapshot considers it restorable,
//    and the test overwrites it. Anyone running these specs on a machine they also use should not
//    keep a file copy on the clipboard while the suite runs.
//
// 2. The clipboard is SHARED with every other process, and host-resident clipboard managers (on
//    the reference dev box: PowerToys `AdvancedPaste` / `QuickAccess`) touch it every time its
//    contents change. A write can therefore be dropped or land later than the assertion expects,
//    which is how a green suite turns red with no code change behind it. So every wait gets a
//    budget far above Playwright's 5s default, and retryable cases retry instead of failing.
//
// NOTE: retrying is only safe for IDEMPOTENT actions (copy / select-all). Do not use
// `expectClipboardAfter` around an action with a side effect beyond the clipboard.
import { expect } from '@playwright/test'
import type { AppHandle } from './launch'

// ── Where a clipboard spec is allowed to run ───────────────────────────────────────────────────
//
// The two problems above cannot be fully solved from inside the test: snapshot/restore is best
// effort (point 1) and a write can land late (point 2). On a developer's own desktop that is a
// real cost — an interrupted run leaves the test payload behind, and a restore landing after the
// user copied something new would replace exactly that. So the specs that touch the clipboard live
// in their own Playwright project (`e2e-clipboard` in playwright.config.ts), which is the only one
// that sets the `clipboardE2e` option:
//
//   npm run e2e:clipboard                       # the whole project
//   npm run e2e:clipboard -- e2e/specs/context-menu.e2e.spec.ts
//
// A spec reads the option (`test` comes from helpers/fixtures.ts) and gates itself with
// `test.skip(!clipboardE2e, CLIPBOARD_SPEC_SKIP_REASON)` before it touches the clipboard, and
// snapshots only when enabled — `restoreClipboard` treats `undefined` as "nothing to do", so a run
// in any other project performs NO clipboard write at all (not even putting back what was already
// there).
//
// The same payload-level coverage that does not need a real OS clipboard lives in the main-process
// handler tests (electron/main/handlers/app.test.ts) and the renderer copy tests; these specs are
// the last line of defence, not the only one.
export const CLIPBOARD_SPEC_SKIP_REASON =
  'writes the real system clipboard — runs in the e2e-clipboard project (npm run e2e:clipboard)'

/** Generous on purpose: a collision makes the payload arrive late, not never. */
const POLL_TIMEOUT_MS = 10_000

export async function clearClipboard(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate(({ clipboard }) => clipboard.clear())
}

/** Plain-text payload (`clipboard.readText`). */
export async function readClipboardText(app: AppHandle): Promise<string> {
  return app.electronApp.evaluate(async ({ clipboard }) => clipboard.readText())
}

/** Every MIME type present, across all clipboard items. */
export async function readClipboardTypes(app: AppHandle): Promise<string[]> {
  return app.electronApp.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    return items.flatMap((item) => item.types)
  })
}

/** The `text/html` payload (Electron surfaces html + text + images through `clipboard.read()`). */
export async function readClipboardHtml(app: AppHandle): Promise<string> {
  return app.electronApp.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const item = items.find((entry) => entry.types.includes('text/html'))
    if (!item) return ''
    const blob = (await item.getType('text/html')) as Blob
    return blob.text()
  })
}

/** Whether any clipboard item carries the given MIME type. */
export async function clipboardHasType(app: AppHandle, mime: string): Promise<boolean> {
  return (await readClipboardTypes(app)).includes(mime)
}

// ── Preserve the user's clipboard ──────────────────────────────────────────────────────────────
//
// Usage in a spec (`test` from helpers/fixtures.ts, so `clipboardE2e` is available):
//
//   let snap: ClipboardSnapshot | undefined
//   test.beforeEach(async ({ clipboardE2e }) => {
//     test.skip(!clipboardE2e, CLIPBOARD_SPEC_SKIP_REASON)
//     handle = await launchApp()
//     snap = await snapshotClipboard(handle)
//     test.skip(!snap.restorable, clipboardSkipMessage(snap))
//   })
//   test.afterEach(async () => {
//     if (!handle) return                       // the gate aborted before launching
//     await restoreClipboard(handle, snap)      // no-op when undefined / !restorable
//     await closeApp(handle)
//   })

export interface ClipboardSnapshot {
  /** MIME types that were on the clipboard. */
  types: string[]
  /** type → base64 payload. */
  data: Record<string, string>
  /**
   * False when the clipboard holds something we could not read back. Restoring then would
   * silently DROP the user's data, so the caller must not touch the clipboard at all.
   */
  restorable: boolean
  /** Why it is not restorable — goes into the skip message. */
  reason?: string
}

export async function snapshotClipboard(app: AppHandle): Promise<ClipboardSnapshot> {
  return app.electronApp.evaluate(async ({ clipboard }) => {
    const data: Record<string, string> = {}
    const types: string[] = []
    let items: Awaited<ReturnType<typeof clipboard.read>>
    try {
      items = await clipboard.read()
    } catch (e) {
      return {
        types,
        data,
        restorable: false,
        reason: `clipboard.read() failed: ${String(e)}`,
      }
    }
    try {
      for (const item of items) {
        for (const type of item.types) {
          const blob = (await item.getType(type)) as Blob
          data[type] = Buffer.from(await blob.arrayBuffer()).toString('base64')
          types.push(type)
        }
      }
    } catch (e) {
      return {
        types,
        data,
        restorable: false,
        reason: `a clipboard type could not be read: ${String(e)}`,
      }
    }
    // Electron 44's Clipboard has no `availableFormats()` — the API is W3C-style
    // `read` / `write` / `has`. So native formats cannot be enumerated; this is the best effort.
    // If `read()` came back empty while the clipboard claims to hold a common type, something is
    // there that we could not copy out, and restoring it would silently drop the user's data.
    if (types.length === 0) {
      for (const mime of ['text/plain', 'text/html', 'text/uri-list', 'image/png']) {
        if (await clipboard.has(mime)) {
          return {
            types,
            data,
            restorable: false,
            reason: `clipboard reports ${mime} but read() returned nothing`,
          }
        }
      }
    }
    return { types, data, restorable: true }
  })
}

/** Put the snapshot back. A no-op when it was not restorable (the clipboard was never touched). */
export async function restoreClipboard(
  app: AppHandle,
  snap: ClipboardSnapshot | undefined,
): Promise<void> {
  if (!snap || !snap.restorable) return
  if (snap.types.length === 0) {
    await clearClipboard(app)
    return
  }
  await app.electronApp.evaluate(async ({ clipboard, ClipboardItem }, payload) => {
    // `ClipboardItem` takes Blobs (not Buffers), so each payload is re-wrapped with its MIME.
    const entries: Record<string, Blob> = {}
    for (const [type, b64] of Object.entries(payload)) {
      entries[type] = new Blob([Buffer.from(b64, 'base64')], { type })
    }
    await clipboard.write([new ClipboardItem(entries)])
  }, snap.data)
}

/**
 * Message for `test.skip(!snap?.restorable, clipboardSkipMessage(snap))`. An absent snapshot means
 * this project does not run clipboard specs (`snap` is only captured when `clipboardE2e` is set).
 */
export function clipboardSkipMessage(snap: ClipboardSnapshot | undefined): string {
  if (!snap) return CLIPBOARD_SPEC_SKIP_REASON
  return `clipboard left untouched: ${snap.reason ?? 'cannot be restored'}`
}

// ── Seed + assert ─────────────────────────────────────────────────────────────────────────────

let seedSeq = 0

/**
 * Replace the clipboard with a value we can recognise.
 *
 * This is what makes an assertion meaningful — without it, "the clipboard contains hello world"
 * could pass on a leftover from an earlier test. A recognisable sentinel is strictly better than
 * `clear()`: when the app fails to write, the failure message shows `<markflow-e2e-clipboard-…>`
 * instead of an empty string, which says "the copy never happened" rather than "something odd".
 */
export async function seedClipboard(app: AppHandle): Promise<string> {
  const marker = `<markflow-e2e-clipboard-${process.pid}-${++seedSeq}>`
  await app.electronApp.evaluate(({ clipboard }, text: string) => clipboard.writeText(text), marker)
  return marker
}

/**
 * Seed, run `action` (whatever writes the clipboard), then wait until `probe` matches.
 *
 * If it does not match within the budget, the clipboard is re-seeded and the action is run again —
 * a clipboard manager holding the clipboard at that instant is the known cause and is transient.
 * When every attempt fails, the error prints what the clipboard actually held.
 */
export async function expectClipboardAfter(
  app: AppHandle,
  action: () => Promise<void>,
  probe: () => Promise<string>,
  matcher: string | RegExp,
  opts: { attempts?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 2
  let lastActual = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await seedClipboard(app)
    await action()
    try {
      const poll = expect.poll(probe, { timeout: POLL_TIMEOUT_MS })
      if (typeof matcher === 'string') await poll.toContain(matcher)
      else await poll.toMatch(matcher)
      return
    } catch {
      lastActual = await probe().catch(() => '<unreadable>')
    }
  }
  throw new Error(
    `clipboard never received the expected payload after ${attempts} attempt(s).\n` +
      `  expected: ${String(matcher)}\n` +
      `  actual:   ${String(lastActual).slice(0, 400) || '<empty>'}\n` +
      `  hint: if the actual value still starts with <markflow-e2e-clipboard-, the app never ` +
      `wrote the clipboard; otherwise a clipboard manager (PowerToys AdvancedPaste / QuickAccess) ` +
      `may be holding it — close it and re-run.`,
  )
}
