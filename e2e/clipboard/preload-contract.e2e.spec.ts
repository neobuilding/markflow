// Clipboard-only case extracted from e2e/app/preload-contract.e2e.spec.ts (ADR-0034).
// Runs only in the e2e-clipboard project; the other 10 bridge cases live in e2e/app.
import type {} from '../../src/renderer/src/vite-env.d.ts'
import { expect } from '@playwright/test'
import { waitForAppReady, AppHandle } from '../helpers/launch'
import { test } from '../helpers/fixtures'

test.describe('preload bridge contract — clipboard handlers', () => {
  let handle: AppHandle

  // The gate, the launch, the snapshot, the restore and the close are owned by the shared
  // clipboard fixture (helpers/fixtures.ts) — one implementation for all six clipboard specs.
  test.beforeEach(async ({ clipboardApp }) => {
    handle = clipboardApp
  })

  // Reopened 2026-09-22: this used to assert only "the call does not throw", which stayed green
  // while `clipboard:write-image` / `write-svg` copied NOTHING — the handler built a
  // `new ClipboardItem(...)` from a `declare const` that does not exist at runtime in the main
  // process, and swallowed the resulting ReferenceError. Both handlers are exercised through the
  // real system clipboard here: "no throw" is not a clipboard write.
  test('clipboard:writeSvg and writeImage really land on the system clipboard', async () => {
    const { page } = handle
    await waitForAppReady(page)

    const clear = () => handle.electronApp.evaluate(({ clipboard }) => clipboard.clear())
    const readTypes = () =>
      handle.electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        return items.map((item) => item.types)
      })

    // A 1x1 PNG (the same fixture the export tests use): a truncated PNG decodes to an empty
    // nativeImage, which the handler correctly refuses to write — it must be a real image.
    const PNG_HEX =
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082'

    await clear()
    await page.evaluate(async (hex) => {
      const bytes = new Uint8Array(hex.length / 2)
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      }
      let bin = ''
      bytes.forEach((b) => {
        bin += String.fromCharCode(b)
      })
      await window.api.clipboard.writeImage(`data:image/png;base64,${btoa(bin)}`)
    }, PNG_HEX)
    await expect
      .poll(async () => (await readTypes()).some((types) => types.includes('image/png')), {
        timeout: 15_000,
      })
      .toBe(true)

    // The vector payload: Electron does not surface the custom `image/svg+xml` MIME through
    // `clipboard.read()` (only `text/html` comes back), so assert the HTML wrapper really carries
    // the diagram — before the ClipboardItem fix the clipboard was simply empty here.
    await clear()
    const readClipHtml = () =>
      handle.electronApp.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read()
        const item = items.find((entry) => entry.types.includes('text/html'))
        if (!item) return ''
        const blob = (await item.getType('text/html')) as Blob
        return await blob.text()
      })
    await page.evaluate(async () => {
      await window.api.clipboard.writeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
    })
    await expect
      .poll(async () => (await readClipHtml()).includes('data:image/svg+xml;base64,'), {
        timeout: 15_000,
      })
      .toBe(true)
  })
})
