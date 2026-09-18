// App-level IPC handlers: get-initial-paths / show-in-folder / get-version.
// Extracted from index.ts.
import { ipcMain, shell, app, clipboard, nativeImage } from 'electron'
import { readFileSync, copyFileSync } from 'node:fs'
import { resolveAppdocPath } from '../ipc/appdoc'
import { pendingInitialPaths } from '../state'

// Electron 44 injects the web-standard `ClipboardItem` global into the main process
// (it is what `clipboard.write` consumes). It is not a named export of the `electron`
// module — its type is `Electron.ClipboardItem`, and at runtime this binding resolves
// to the Electron-injected global.
declare const ClipboardItem: typeof Electron.ClipboardItem

// Resolve a clipboard image source to raw bytes. Supports three forms:
//  - `data:` URL (rasterized mermaid SVG from the renderer) → decoded in-process
//  - `appdoc://…` → resolved through the protocol handler's security layer
//  - plain disk path → read directly
// Returns null when the source is unreadable / escapes its document directory.
function decodeImageSource(src: string): Buffer | null {
  if (src.startsWith('data:')) return decodeDataUrl(src)
  const path = src.startsWith('appdoc://') ? resolveAppdocPath(src) : src
  if (!path) return null
  return readFileSync(path)
}

function decodeDataUrl(src: string): Buffer | null {
  const comma = src.indexOf(',')
  if (comma === -1) return null
  const meta = src.slice(0, comma)
  const body = src.slice(comma + 1)
  if (/;base64$/i.test(meta)) {
    // `Buffer.from(body, 'base64')` never throws (invalid input decodes to an empty
    // buffer), so there is no failure path to guard here.
    return Buffer.from(body, 'base64')
  }
  // Non-base64 data URLs carry URL-encoded (percent-escaped) bytes; a malformed
  // escape (e.g. a lone "%") is unrecoverable, so treat it as undecodable.
  try {
    return Buffer.from(decodeURIComponent(body), 'utf-8')
  } catch {
    return null
  }
}

export function registerAppHandlers(): void {
  // After the renderer starts, proactively pull the pending open paths accumulated at launch (CLI args, etc.)
  ipcMain.handle('app:get-initial-paths', () => {
    const paths = pendingInitialPaths.splice(0, pendingInitialPaths.length)
    return paths
  })

  // Locate and highlight the given file in the system file manager
  ipcMain.handle('app:show-in-folder', (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
    } catch {
      // Ignore: the file may not exist or we lack permission
    }
  })

  // Renderer's "About" dialog fetches the app version (in production this is the injected rolling version)
  ipcMain.handle('app:get-version', () => app.getVersion())

  // Write text to the system clipboard from the renderer.
  // Electron 44+: `writeText` is async (returns a Promise) and may reject, so we
  // await it; the try/catch swallows both synchronous throws and async rejections.
  ipcMain.handle('clipboard:write-text', async (_event, text: string) => {
    try {
      await clipboard.writeText(text)
    } catch {
      // Ignore clipboard failures
    }
  })

  // Copy an image to the system clipboard. `src` is a disk path, an `appdoc://` URL, or a
  // `data:` URL (e.g. a rasterized mermaid SVG produced on the renderer). `resolveAppdocPath`
  // reuses the protocol handler's security layer (doc lookup → containment check → exists) so an
  // appdoc reference can never escape its document directory. Reads raw bytes, builds a native
  // image, and writes it via the W3C-style `clipboard.write([ClipboardItem])` API. Electron 44
  // removed `clipboard.writeImage`, so we encode the image as a PNG blob; failures are
  // swallowed so a bad path can't crash the handler.
  ipcMain.handle('clipboard:write-image', async (_event, src: string) => {
    try {
      const buf = decodeImageSource(src)
      if (!buf || buf.length === 0) return
      const image = nativeImage.createFromBuffer(buf)
      if (image.isEmpty()) return
      const blob = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
      await clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch {
      // Ignore unreadable / unsupported image paths
    }
  })

  // Copy an SVG as a vector (Plan 02 §4.4 / D4). Writes `image/svg+xml` so Word / vector
  // editors receive true vector art, and a `text/html` wrapper (`<img src="data:…">`) so plain
  // HTML paste also lands the diagram. A single ClipboardItem carrying both MIME types keeps
  // the two formats together; failures are swallowed.
  ipcMain.handle('clipboard:write-svg', async (_event, svg: string) => {
    try {
      const b64 = Buffer.from(svg).toString('base64')
      const svgBlob = new Blob([svg], { type: 'image/svg+xml' })
      const htmlBlob = new Blob([`<img src="data:image/svg+xml;base64,${b64}">`], {
        type: 'text/html',
      })
      await clipboard.write([
        new ClipboardItem({ 'image/svg+xml': svgBlob, 'text/html': htmlBlob }),
      ])
    } catch {
      // Ignore unsupported SVG / clipboard formats
    }
  })

  // Open a URL in the user's default browser (used by "Open Link in Browser"
  // context-menu items). shell.openExternal is fire-and-forget and may
  // reject on an invalid URL or if the OS declines; swallow the rejection so a bad
  // link can't crash the handler.
  ipcMain.handle('app:open-external', (_event, url: string) => {
    try {
      // Swallow both a synchronous throw and an async rejection so a bad link
      // can never crash the handler.
      void shell.openExternal(url).catch(() => {
        // Ignore rejection (invalid URL / OS declined)
      })
    } catch {
      // Ignore synchronous failure (e.g. invalid argument)
    }
  })

  // Copy a file to a user-chosen destination (used by the preview's "Save image as" /
  // "Save diagram as" menu items, / ). `src` may be a disk path or an
  // `appdoc://` URL; the same security layer from the protocol handler bounds the resolution.
  // Fails silently so a bad source never crashes the handler.
  ipcMain.handle('app:copy-file', (_event, src: string, dest: string) => {
    try {
      const path = src.startsWith('appdoc://') ? resolveAppdocPath(src) : src
      if (!path) return
      copyFileSync(path, dest)
    } catch {
      // Ignore unreadable source / unwritable destination
    }
  })
}
