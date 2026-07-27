// Export pipeline (R7): reuse the preview's "sanitized HTML" as the single source of truth,
// supporting image inlining and file writing.
// The renderer is responsible for assembling the full HTML (inlining github-markdown-css / katex.css / theme),
// and this file does only the two main-process-specific things:
//  1) export:embed-images —— inline <img> sources (appdoc:// or https:) as base64 data URLs;
//  2) export:write —— write the final HTML to the user-selected path.
// Image reading / network fetching must happen in the main process (the renderer sandbox has no Node API).
import type { IpcMain } from 'electron'
import { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db/database'
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
      const row = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(docId) as
        | { file_path: string }
        | undefined
      if (!row) return null
      const base = dirname(row.file_path)
      const resolved = resolve(base, rel)
      if (!isSubdir(base, resolved) || !existsSync(resolved)) return null
      const buf = readFileSync(resolved)
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
      out += dataUrl
        ? `<img${pre}src="${dataUrl}"${post}>`
        : full // inline failed: keep original <img> (remote image still renders online after export)
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
      if (existsSync(filePath) && !overwrite) {
        throw new Error('FILE_EXISTS') // already confirmed by renderer; the normal flow won't hit this
      }
      writeFileSync(filePath, html, 'utf-8') // html is a utf-8 string (with the original encoding-declaring <meta>)
    }
  )

  // Shared: drop the fully-assembled HTML from the renderer into a hidden BrowserWindow, wait for
  // rendering to finish (readyState==='complete', large inlined images drawn), then pop the system
  // print dialog so the user picks the target (physical printer / "Save as PDF"), paper size and margins.
  // This is real printing (explicitly requested by the user; not downgraded to PDF export); exported bytes are uniformly UTF-8.
  // Improvement ④: use a temp file via loadFile instead of a data: URL — avoids large documents (multiple base64-inlined
  //   images) exceeding Chromium's length limit on data: URLs and silently truncating/failing; temp file is deleted after printing.
  function mapPrintFailureReason(reason?: string): string {
    if (!reason) return 'Print failed'
    const lower = reason.toLowerCase()
    if (lower.includes('invalid printer settings')) {
      return 'The system default printer is invalid, or no usable printer is installed. Check Windows "Printers & scanners", or set "Microsoft Print to PDF" as the default printer and try again.'
    }
    return reason
  }

  async function openPrintDialog(html: string): Promise<void> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const tmp = join(tmpdir(), `mf-print-${process.pid}-${randomUUID()}.html`)
    try {
      writeFileSync(tmp, html, 'utf-8')
      await win.loadFile(tmp)
      await win.webContents
        .executeJavaScript(
          'new Promise(r => { if (document.readyState === "complete") r(); else window.addEventListener("load", r) })'
        )
        .catch(() => {})
      // On Windows the system print dialog is modal to the parent window; if the parent is fully hidden (show:false),
      // the dialog loses foreground focus and appears to "do nothing when clicked". But moving the window off-screen (-10000,-10000)
      // makes some printer drivers (including Microsoft Print to PDF) get invalid monitor info during init,
      // causing them all to report Invalid printer settings. So place the window at valid on-screen coords and minimize it,
      // which both keeps the print dialog foregrounded and avoids flashing/disturbing the user.
      win.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      win.show()
      win.minimize()
      win.focus()
      // Note: earlier versions were plagued by a "stray top-of-page horizontal rule" and wrongly blamed the
      // system print dialog's "Headers and footers" separator line, trying to disable it via the headerFooterEnabled
      // option (removed in Electron 43). Testing proved the line is not system-generated (no such setting in the
      // dialog, disabling did nothing): it is a CSS bug in the renderer's `<hr>` — old rules `height:0; overflow:visible`
      // plus GitHub's `.markdown-body`/`hr` `::before`/`::after` clearfix pseudo-elements render a residual line at the
      // top of the page in some print engines. The issue is fixed in the renderer's print CSS
      // (src/renderer/src/lib/export.ts's @media print) by "hiding clearfix pseudo-elements + solid background color +
      // print-color-adjust:exact to restore hr", and is unrelated to the system print dialog — no manual checkbox
      // unchecking needed by the user. We keep real printing here, not a downgrade to PDF.
      // Electron 43 has a regression on Windows: passing deviceName/pageSize/margins etc. makes some systems
      // uniformly report Invalid printer settings; so the first attempt passes only the safest empty object,
      // and on failure we try fallbacks adding printBackground, then a specified deviceName.
      const tryPrint = async (
        options: Electron.WebContentsPrintOptions
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
      console.error(`[export:print] Print with empty options failed: ${emptyOutcome.reason ?? 'unknown'}`)

      const bgOutcome = await tryPrint({ printBackground: true })
      if (bgOutcome.type === 'success' || bgOutcome.type === 'cancel') return
      console.error(`[export:print] Print with background failed: ${bgOutcome.reason ?? 'unknown'}`)

      // Fallback: when the empty options also fail, enumerate printers and retry by specifying deviceName in
      // order "default -> PDF -> others". Keep getPrintersAsync in the fallback path to avoid blocking the common path.
      const printers = await win.webContents.getPrintersAsync().catch(() => [])
      if (printers.length === 0) {
        throw new Error(
          'No printer was detected on the system and printing is unavailable. Add a printer in Windows Settings → Bluetooth & devices → Printers & scanners and try again.'
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
        const outcome = await new Promise<{ type: 'success' | 'cancel' | 'error'; reason?: string }>(
          (resolve) => {
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
                }
              )
            } catch (e) {
              resolve({ type: 'error', reason: e instanceof Error ? e.message : String(e) })
            }
          }
        )
        if (outcome.type === 'success' || outcome.type === 'cancel') return
        // Record this failure reason for the summary when candidates are exhausted; also log to the main-process log for debugging.
        attempts.push({ name: candidate.name, reason: outcome.reason })
        console.error(`[export:print] Printer "${candidate.name}" initialization failed: ${outcome.reason ?? 'unknown'}`)
      }
      // All candidates failed: summarize each printer's failure reason so the user/developer can tell
      // whether it's a protected-mode issue or a single-driver problem.
      const summary = attempts
        .map((a, i) => `${i + 1}. "${a.name}": ${mapPrintFailureReason(a.reason)}`)
        .join('\n')
      throw new Error(
        `Could not initialize any available printer. Attempted:\n${summary}\n\nCheck Windows "Printers & scanners", or set "Microsoft Print to PDF" as the default printer and try again.`
      )
    } finally {
      win.destroy()
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  // Print: pop the system print dialog so the user picks the physical printer / copies / margins / target (can save as PDF).
  // Failures (invalid printer settings, no usable printer, etc.) are thrown upward as-is for the renderer to surface; no silent downgrade.
  // Note: this is real printing and is NOT downgraded to "export a PDF file".
  ipcMain.handle('export:print', async (_e, html: unknown): Promise<void> => {
    if (typeof html !== 'string') {
      throw new TypeError('export:print expects string html')
    }
    await openPrintDialog(html)
  })
}
