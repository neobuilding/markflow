import { buildStandaloneHtml, resolveTheme } from './export'
import { getExportHtml } from './exportStore'
import { prepareExportHtml } from './exportBake'
import { t } from '../i18n/translate'
import { useUIStore } from '../store/ui'

/**
 * The single "Print" action. Both entry points (the native File > Print menu and the preview's
 * right-click Print item) go through here, so neither can skip the ADR-0019 "bake EVERY diagram"
 * step or forget to sync the printing state.
 *
 * Deliberately does NOT render a blocking overlay: while the system print dialog is up the main
 * window must stay scrollable / resizable. StatusBar carries the non-blocking "Printing…"
 * indicator from the `printing` flag instead.
 */
export async function printDocument(): Promise<void> {
  // `exportReady` is the same gate the export dialog applies: while it is false the cache still
  // holds the PREVIOUS document's HTML (a switch or a parse is in flight), so printing now would
  // send another document to the printer. Empty cache and stale cache are one user-visible
  // situation — "this document has not finished rendering" — so they share one message.
  if (!getExportHtml() || !useUIStore.getState().exportReady) {
    window.alert(t('app.printNotReady'))
    return
  }
  if (useUIStore.getState().printing) return
  // Setting `printing` flips `fileLocked`, whose store-level subscription mirrors it to the native
  // menu via `menu:set-file-locked`. No direct bridge call here: adding a future trigger source needs
  // no change in this file (the one-place rule of the fileLocked capability).
  useUIStore.getState().setPrinting(true)
  try {
    // ADR 0019: bake EVERY diagram into the canonical HTML first — the preview only renders the
    // ones that scrolled into view, and a printed page must be complete.
    await prepareExportHtml()
    const theme = resolveTheme('current', useUIStore.getState().theme)
    const html = await buildStandaloneHtml({ theme, embedImages: true })
    await window.api.export.print(html)
  } catch (e) {
    console.error('Print failed', e)
    window.alert(t('app.printFailed', { message: (e as Error)?.message || String(e) }))
  } finally {
    // `printing` clears here; the subscription mirrors the new `fileLocked` to the menu.
    useUIStore.getState().setPrinting(false)
  }
}
