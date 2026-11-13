// Export pipeline (R7): reuse the preview's "sanitized HTML" as the single source of truth,
// supporting image inlining and file writing.
// The renderer is responsible for assembling the full HTML (inlining github-markdown-css / katex.css / theme),
// and this file does only the two main-process-specific things:
// 1) export:embed-images inline <img> sources (appdoc:// or https:) as base64 data URLs;
// 2) export:write write the final HTML to the user-selected path
// Image reading / network fetching must happen in the main process (the renderer sandbox has no Node API).
import type { IpcMain } from 'electron'
import { BrowserWindow, screen } from 'electron'
import { getMainWindow } from '../state'
import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { getDocumentById } from '../model/documentStore'
import { isSubdir, APPDOC_MIME, parseAppDocUrl } from '../lib/security'
import { dirname, extname, resolve, join } from 'node:path'

function b64(buf: Buffer): string {
  return buf.toString('base64')
}

// Inline a single image: return a data URL; return null (keep original src) on failure / no inlining.
async function inlineOne(src: string): Promise<string | null> {
  try {
    if (/^data:/i.test(src)) return null
    if (/^appdoc:\/\//i.test(src)) {
      // appdoc://<docId>/<relativePath>: docId sits in the hostname (see parseAppDocUrl comment).
      const parsed = parseAppDocUrl(src)
      if (!parsed) return null
      const { docId, relPath: rel } = parsed
      const doc = getDocumentById(docId)
      if (!doc) return null
      const base = dirname(doc.filePath)
      const resolved = resolve(base, rel)
      if (!isSubdir(base, resolved)) return null
      let buf: Buffer
      try {
        buf = readFileSync(resolved)
      } catch {
        // The file vanished (or is a directory) between the isSubdir check and here; treat as un-inlinable.
        return null
      }
      return `data:${APPDOC_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream'};base64,${b64(buf)}`
    }
    if (/^https?:/i.test(src)) {
      const res = await fetch(src) // main-process Node global fetch
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      const ct = res.headers.get('content-type') ?? 'image/png'
      return `data:${ct};base64,${b64(buf)}`
    }
    return null
  } catch {
    return null
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const PRINT_WINDOW_WIDTH = 800
const PRINT_WINDOW_HEIGHT = 600

/**
 * Where to put the hidden print OWNER window so the SYSTEM print dialog opens on the same monitor
 * as MarkFlow. Pure and unit-tested: `openPrintDialog` drives a real BrowserWindow + OS printer
 * dialog and is excluded from coverage, but the placement decision must not be.
 *
 * `display` is the work area of the monitor that owns the main window; a null main window falls
 * back to the primary display. The native print dialog centres on this owner window's rect, so we
 * place the owner CENTRED on the main window (clamped inside the monitor work area) to make the
 * dialog appear centred over the app instead of pinned to the monitor corner. The result still
 * stays on MarkFlow's monitor (never the primary when the app is elsewhere), and the size is
 * clamped for small displays. `center` defaults to the display centre when no main window is known.
 */
export function resolvePrintWindowBounds(display: Rect, center?: { x: number; y: number }): Rect {
  const width = Math.min(PRINT_WINDOW_WIDTH, display.width)
  const height = Math.min(PRINT_WINDOW_HEIGHT, display.height)
  const cx = center?.x ?? display.x + display.width / 2
  const cy = center?.y ?? display.y + display.height / 2
  const x = Math.max(display.x, Math.min(cx - width / 2, display.x + display.width - width))
  const y = Math.max(display.y, Math.min(cy - height / 2, display.y + display.height - height))
  return { x, y, width, height }
}

/** Pick the display whose work area contains the main window (or the primary one as a fallback). */
export function printDisplayWorkArea(main: BrowserWindow | null): Rect {
  const primary = screen.getPrimaryDisplay().workArea
  if (!main || main.isDestroyed()) return primary
  return screen.getDisplayMatching(main.getBounds()).workArea
}

// Map a raw printer-driver failure reason to a user-facing message. Pure and unit-testable
// (kept outside the BrowserWindow-bound openPrintDialog, which is excluded from coverage).
export function mapPrintFailureReason(reason?: string): string {
  if (!reason) return 'Print failed'
  const lower = reason.toLowerCase()
  if (lower.includes('invalid printer settings')) {
    return 'The system default printer is invalid, or no usable printer is installed. Check Windows "Printers & scanners", or set "Microsoft Print to PDF" as the default printer and try again.'
  }
  return reason
}

export function registerExportHandlers(ipcMain: IpcMain): void {
  // Key pitfall: once String.prototype.replace's callback is marked async it returns a Promise,
  //   and replace will serialize it to "[object Promise]" as the replacement string, corrupting the HTML.
  //   So we loop with exec and await each match, then concatenate the result string.
  ipcMain.handle('export:embed-images', async (_e, html: string): Promise<string> => {
    const RE = /<img([^>]*?)src="([^"]+)"([^>]*)>/gi
    let out = ''
    let last = 0
    let m: RegExpExecArray | null
    while ((m = RE.exec(html)) !== null) {
      const [full, pre, src, post] = m
      out += html.slice(last, m.index)
      const dataUrl = await inlineOne(src)
      out += dataUrl ? `<img${pre}src="${dataUrl}"${post}>` : full // inline failed: keep original <img> (remote image still renders online after export)
      last = m.index + full.length
    }
    out += html.slice(last)
    return out
  })

  // Write HTML to disk. The boundary layer enforces "no silent overwrite": if the target file exists
  // and the caller did not explicitly pass overwrite=true, throw — the upper layer (renderer already
  // asks the user to confirm before calling) decides whether to retry.
  // This way, even if another entry point misuses export:write, it won't overwrite the user's file without confirmation.
  ipcMain.handle(
    'export:write',
    (_e, filePath: unknown, html: unknown, overwrite = false): void => {
      if (typeof filePath !== 'string' || typeof html !== 'string') {
        throw new TypeError('export:write expects string path and html')
      }
      // Atomic create-or-fail via O_EXCL to avoid the existsSync/writeFileSync TOCTOU race.
      // If overwrite is true we deliberately truncate the existing file with 'w'.
      let fd: number
      try {
        fd = openSync(filePath, overwrite ? 'w' : 'wx')
      } catch (e) {
        // EEXIST is the normal "file already exists, don't overwrite" path; any other openSync
        // error (e.g. a missing parent directory / permission) propagates unchanged. The renderer
        // already confirms before calling, so both are genuine error paths covered by tests below.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw Object.assign(new Error('FILE_EXISTS'), { cause: e })
        }
        throw e
      }
      try {
        writeSync(fd, html, undefined, 'utf-8') // html is a utf-8 string (with the original encoding-declaring <meta>)
      } finally {
        closeSync(fd)
      }
    },
  )

  // Shared: drop the fully-assembled HTML from the renderer into a HIDDEN owner BrowserWindow,
  // wait for rendering to finish (readyState==='complete', large inlined images drawn), then pop the
  // SYSTEM print dialog so the user picks the target (physical printer / "Save as PDF"), paper size
  // and margins. The owner is transparent/click-through — the user looks at the MAIN window's own
  // preview pane instead (R5 plan A), and the OS dialog stays owned by this hidden window.
  // This is real printing (explicitly requested by the user; not downgraded to PDF export); exported bytes are uniformly UTF-8.
  // Improvement ④: use a temp file via loadFile instead of a data: URL — avoids large documents (multiple base64-inlined
  //   images) exceeding Chromium's length limit on data: URLs and silently truncating/failing; temp file is deleted after printing.
  /* v8 ignore start: the print path drives a real BrowserWindow + system printer dialog and
  cannot be exercised in a Node unit test (no display / printer). It is covered by manual smoke
  testing of the "Print" menu item. */
  async function openPrintDialog(html: string): Promise<void> {
    const mainWindow = getMainWindow()
    // R5 plan A (user decision 2026-11-12): NO standalone print PREVIEW window. The user watches
    // the MAIN window's own preview pane — the mainstream pattern (Windows UX Guide recommends
    // print preview "directly within the main program window"; Chrome / Word / macOS all
    // integrate it). Only two windows remain:
    //   - `win`  HIDDEN OWNER. Its webContents calls print(), so the SYSTEM print dialog is modal
    //            to THIS window only; Windows disables a modal dialog's owner, which is fine
    //            because the user neither sees nor interacts with this window.
    //   - mainWindow  stays ENABLED. A whole-window setEnabled(false) would also freeze the
    //            preview pane the user is meant to scroll. "No editing / no switching or closing
    //            files" is a fine-grained print-mode lock in the RENDERER (store/ui.ts + native
    //            menu states), not an OS-level window disable.
    const win = new BrowserWindow({
      show: false,
      // The owner MUST keep a taskbar button while printing: the system print dialog is an OWNED
      // window with no taskbar entry of its own, so this button is the recovery anchor if the
      // dialog sinks behind another application.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    // Use mkdtempSync for a dedicated temp directory so the temp file path is not
    // predictable and cannot be substituted between creation and use (CodeQL insecure temp file).
    // Declared outside the try block so that, if mkdtempSync itself throws (e.g. the temp dir is
    // unavailable), the finally block still destroys the window instead of leaking it.
    let tmpDir: string | undefined
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'mf-print-'))
      const tmp = join(tmpDir, 'doc.html')
      writeFileSync(tmp, html, 'utf-8')
      await win.loadFile(tmp)
      await win.webContents
        .executeJavaScript(
          'new Promise(r => { if (document.readyState === "complete") r(); else window.addEventListener("load", r) })',
        )
        .catch(() => {})
      // On Windows the system print dialog is modal to its owner window, and BOTH its placement
      // and its interactivity are decided by the owner's window state (measured 2026-11-12, R5/R6):
      //   - A MINIMIZED owner is moved by Windows to the classic -32000,-32000 "minimized
      //     position", so the dialog — which centers on its owner's rect — lands nearest that
      //     point: the leftmost/primary monitor, no matter where MarkFlow is. That is exactly the
      //     reported "print window always opens on the left screen".
      //   - A fully HIDDEN (show:false) owner makes the dialog lose the foreground and appear
      //     frozen ("does nothing when clicked").
      //   - An OFF-SCREEN owner (-10000,-10000) breaks some printer drivers (Microsoft Print to
      //     PDF reports Invalid printer settings during init), so the owner must sit on a real
      //     monitor at real coordinates.
      // The owner therefore STAYS a shown, on-screen, real window on the anchored monitor — fully
      // visible to the dialog's placement and focus logic — but transparent and click-through,
      // because it is an implementation detail, not something the user should see or hit.
      //
      // Hard-coding (0,0) pinned the dialog to the PRIMARY monitor, so on a multi-monitor setup
      // with MarkFlow on a secondary display the dialog silently opened off-screen and the user
      // waited for a dialog they could not see. Anchor it to the monitor the main window is on.
      //
      // `getMainWindow()` is a module-level reference and can legitimately be null (a menu command
      // that fires while it is unset, or after a renderer reload). Falling straight through to the
      // primary display in that case reproduces the very bug this anchoring exists to fix, so the
      // anchor degrades through the windows we can actually see first.
      const anchor =
        mainWindow ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => w !== win) ??
        null
      const display = printDisplayWorkArea(anchor)
      const anchorRect = anchor && !anchor.isDestroyed() ? anchor.getBounds() : null
      const center = anchorRect
        ? {
            x: anchorRect.x + (anchorRect.width ?? display.width) / 2,
            y: anchorRect.y + (anchorRect.height ?? display.height) / 2,
          }
        : undefined
      win.setBounds(resolvePrintWindowBounds(display, center))
      // The owner MUST be transparent BEFORE `show` fires. Showing it opaque first and calling
      // setOpacity(0) afterwards painted one fully visible 800x600 frame in the corner — the
      // "small preview window flashes by" reported 2026-11-13. An e2e hook on the `show` event
      // measured opacity === 1 there; with the call moved up, the window is invisible from its
      // very first painted frame while still being a real, focusable, on-screen owner for the
      // system print dialog (Windows needs that for placement and foreground, see above).
      win.setOpacity(0)
      win.show()
      win.setIgnoreMouseEvents(true)
      // The dialog is modal to this owner, so ITS foreground state is what the dialog inherits.
      // Without focus() the dialog can open behind other windows and look like it "never showed up".
      win.focus()
      // Note: earlier versions were plagued by a "stray top-of-page horizontal rule" and wrongly blamed the
      // system print dialog's "Headers and footers" separator line, trying to disable it via the headerFooterEnabled
      // option (removed in Electron 43). Testing proved the line is not system-generated (no such setting in the
      // dialog, disabling did nothing): it is a CSS bug in the renderer's `<hr>` old rules `height:0; overflow:visible`
      // plus GitHub's `.markdown-body`/`hr` `::before`/`::after` clearfix pseudo-elements render a residual line at the
      // top of the page in some print engines. The issue is fixed in the renderer's print CSS
      // (src/renderer/src/lib/export.ts's @media print) by "hiding clearfix pseudo-elements + solid background color +
      // print-color-adjust:exact to restore hr", and is unrelated to the system print dialog no manual checkbox
      // unchecking needed by the user. We keep real printing here, not a downgrade to PDF.
      // Electron 43 has a regression on Windows: passing deviceName/pageSize/margins etc. makes some systems
      // uniformly report Invalid printer settings; so the first attempt passes only the safest empty object,
      // and on failure we try fallbacks adding printBackground, then a specified deviceName.
      const tryPrint = async (
        options: Electron.WebContentsPrintOptions,
      ): Promise<{ type: 'success' | 'cancel' | 'error'; reason?: string }> => {
        return new Promise((resolve) => {
          try {
            win.webContents.print(options, (success: boolean, reason?: string) => {
              if (success) resolve({ type: 'success' })
              else if (reason && /cancel/i.test(reason)) resolve({ type: 'cancel' })
              else resolve({ type: 'error', reason })
            })
          } catch (e) {
            resolve({ type: 'error', reason: e instanceof Error ? e.message : String(e) })
          }
        })
      }

      const emptyOutcome = await tryPrint({})
      if (emptyOutcome.type === 'success' || emptyOutcome.type === 'cancel') return
      console.error(
        `[export:print] Print with empty options failed: ${emptyOutcome.reason ?? 'unknown'}`,
      )

      const bgOutcome = await tryPrint({ printBackground: true })
      if (bgOutcome.type === 'success' || bgOutcome.type === 'cancel') return
      console.error(`[export:print] Print with background failed: ${bgOutcome.reason ?? 'unknown'}`)

      // Fallback: when the empty options also fail, enumerate printers and retry by specifying deviceName in
      // order "default -> PDF -> others". Keep getPrintersAsync in the fallback path to avoid blocking the common path.
      const printers = await win.webContents.getPrintersAsync().catch(() => [])
      if (printers.length === 0) {
        throw new Error(
          'No printer was detected on the system and printing is unavailable. Add a printer in Windows Settings → Bluetooth & devices → Printers & scanners and try again.',
        )
      }
      const isDefaultPrinter = (p: (typeof printers)[number]): boolean =>
        (p as unknown as { isDefault?: boolean }).isDefault === true
      const defaults = printers.filter(isDefaultPrinter)
      const rest = printers.filter((p) => !isDefaultPrinter(p))
      const score = (name: string): number => {
        if (/microsoft print to pdf/i.test(name)) return 0
        if (/print to pdf/i.test(name)) return 1
        if (/pdf/i.test(name)) return 2
        return 3
      }
      rest.sort((a, b) => score(a.name) - score(b.name))
      const ordered = [...defaults, ...rest]

      // Try each candidate printer in turn: stop on success or user cancel; on failure (non-cancel) move to the next.
      const attempts: { name: string; reason?: string }[] = []
      for (const candidate of ordered) {
        const outcome = await new Promise<{
          type: 'success' | 'cancel' | 'error'
          reason?: string
        }>((resolve) => {
          try {
            win.webContents.print(
              {
                printBackground: true,
                deviceName: candidate.name,
                pageSize: 'A4',
                margins: { marginType: 'default' },
              },
              (success: boolean, reason?: string) => {
                if (success) resolve({ type: 'success' })
                // User canceling the print dialog is not a failure; just stop silently.
                else if (reason && /cancel/i.test(reason)) resolve({ type: 'cancel' })
                else resolve({ type: 'error', reason })
              },
            )
          } catch (e) {
            resolve({ type: 'error', reason: e instanceof Error ? e.message : String(e) })
          }
        })
        if (outcome.type === 'success' || outcome.type === 'cancel') return
        // Record this failure reason for the summary when candidates are exhausted; also log to the main-process log for debugging.
        attempts.push({ name: candidate.name, reason: outcome.reason })
        console.error(
          `[export:print] Printer "${candidate.name}" initialization failed: ${outcome.reason ?? 'unknown'}`,
        )
      }
      // All candidates failed: summarize each printer's failure reason so the user/developer can tell
      // whether it's a protected-mode issue or a single-driver problem.
      const summary = attempts
        .map((a, i) => `${i + 1}. "${a.name}": ${mapPrintFailureReason(a.reason)}`)
        .join('\n')
      throw new Error(
        `Could not initialize any available printer. Attempted:\n${summary}\n\nCheck Windows "Printers & scanners", or set "Microsoft Print to PDF" as the default printer and try again.`,
      )
    } finally {
      win.destroy()
      if (tmpDir !== undefined) {
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* ignore cleanup failure */
        }
      }
    }
  }
  /* v8 ignore stop */

  // Print: pop the system print dialog so the user picks the physical printer / copies / margins / target (can save as PDF).
  // Failures (invalid printer settings, no usable printer, etc.) are thrown upward as-is for the renderer to surface; no silent downgrade.
  // Note: this is real printing and is NOT downgraded to "export a PDF file".
  ipcMain.handle('export:print', async (_e, html: unknown): Promise<void> => {
    // The non-string branch throws (covered by the TypeError test); the string branch delegates to
    // the hidden owner BrowserWindow path, which is exercised only manually (no display / printer
    // in a Node unit test), so that delegation line is excluded from coverage below.
    if (typeof html !== 'string') {
      throw new TypeError('export:print expects string html')
    }
    /* v8 ignore next: drives a real BrowserWindow + system printer dialog; untestable in Node */
    await openPrintDialog(html)
  })
}
