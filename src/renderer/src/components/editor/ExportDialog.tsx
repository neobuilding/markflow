import React, { useEffect, useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useDocument } from '../../hooks/useDocuments'
import { exportDocument, resolveTheme } from '../../lib/export'
import { getExportHtml } from '../../lib/exportStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'

type ThemeChoice = 'current' | 'light' | 'dark'

function defaultHtmlPath(docPath: string | undefined, title: string): string {
  if (docPath) return docPath.replace(/\.(md|markdown|mdx|mdtxt|mdtext)$/i, '.html')
  return `${title.trim() || 'Untitled'}.html`
}

export function ExportDialog(): React.ReactElement {
  const open = useUIStore((s) => s.exportOpen)
  const setOpen = useUIStore((s) => s.setExportOpen)
  const uiTheme = useUIStore((s) => s.theme)
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const { data: doc } = useDocument(activeDocumentId)

  const [themeChoice, setThemeChoice] = useState<ThemeChoice>('current')
  const [embedImages, setEmbedImages] = useState(true)
  const [targetPath, setTargetPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When the target file already exists, confirm inline within the dialog (instead of the native
  // window.confirm): the native confirm is a blocking modal that conflicts with the app menu
  // shortcut (Close Workspace = Cmd/Ctrl+W) and the current modal export dialog, which could
  // accidentally close the whole workspace at the moment of cancel/confirm.
  const [showOverwrite, setShowOverwrite] = useState(false)

  // Reset state and provide a default target path when the dialog opens.
  useEffect(() => {
    if (open) {
      setThemeChoice('current')
      setEmbedImages(true)
      setError(null)
      setShowOverwrite(false)
      setTargetPath(doc ? defaultHtmlPath(doc.filePath, doc.title) : null)
    }
  }, [open, doc])

  const handlePickPath = async (): Promise<void> => {
    const def = doc ? defaultHtmlPath(doc.filePath, doc.title) : 'export.html'
    try {
      const p = await window.api.dialog.saveHtmlFile(def)
      if (p) setTargetPath(p)
    } catch {
      /* cancelled */
    }
  }

  // Perform the actual write (temporarily stop watching the current document's disk file during
  // export to avoid false "file changed" reports on some platforms when writing the sibling .html;
  // resume watching after export so the current file/workspace is never closed).
  const doExport = async (overwrite: boolean): Promise<void> => {
    if (!targetPath) return
    setBusy(true)
    setError(null)
    // Hard lock: mark exporting for the whole write; the store-level closeDocument/closeWorkspace
    // will ignore it, so even triggering the "Close Workspace" shortcut (Cmd/Ctrl+W) won't close
    // the current file/workspace.
    useUIStore.getState().setExporting(true)
    try {
      if (activeDocumentId) {
        try {
          await window.api.documents.unwatch(activeDocumentId)
        } catch {
          /* ignored */
        }
      }
      await exportDocument({
        path: targetPath,
        theme: resolveTheme(themeChoice, uiTheme),
        embedImages,
        overwrite,
      })
      setOpen(false)
    } catch (e) {
      console.error('Export failed', e)
      setError('Export failed. Please try again.')
    } finally {
      if (activeDocumentId) {
        try {
          await window.api.documents.watch(activeDocumentId)
        } catch {
          /* ignored */
        }
      }
      useUIStore.getState().setExporting(false)
      setBusy(false)
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!targetPath) {
      await handlePickPath()
      return
    }
    if (!getExportHtml()) {
      setError('Preview is not ready yet. Please switch to the preview or split view first.')
      return
    }
    // When the target file already exists, show the inline confirm first (don't call the native
    // window.confirm to avoid accidentally closing the workspace). If the user chose "Overwrite"
    // in the inline confirm, showOverwrite is true and we write directly with overwrite=true.
    if (!showOverwrite) {
      try {
        const st = await window.api.documents.stat(targetPath)
        if (st?.exists) {
          setShowOverwrite(true)
          return
        }
      } catch {
        // Treat as "not exists" if file status can't be read, and continue exporting.
      }
    }
    await doExport(showOverwrite)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export as HTML</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Theme */}
          <div>
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">Theme</label>
            <select
              value={themeChoice}
              onChange={(e) => setThemeChoice(e.target.value as ThemeChoice)}
              className="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="current">Current ({uiTheme})</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          {/* Inline images */}
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={embedImages}
              onChange={(e) => setEmbedImages(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Inline images into a single file (base64, works offline)
          </label>

          {/* Target path */}
          <div>
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">Save location</label>
            <div className="flex items-center gap-2">
              <input
                value={targetPath ?? ''}
                readOnly
                placeholder="Not selected"
                className="flex-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 outline-none text-[var(--color-text-secondary)] truncate"
              />
              <Button variant="outline" size="sm" onClick={handlePickPath}>
                Choose…
              </Button>
            </div>
            <p className="text-2xs text-[var(--color-text-tertiary)] mt-1">
              When not inlined, local images are rewritten to relative paths (distributed alongside the .html), while remote https images are kept.
            </p>
          </div>

          {error && <p className="text-2xs text-red-500">{error}</p>}
        </div>

          {showOverwrite ? (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 mt-4">
              <p className="text-sm text-[var(--color-text-secondary)]">
                File &quot;{targetPath}&quot; already exists. Are you sure you want to overwrite it? This action cannot be undone.
              </p>
              <div className="flex items-center justify-end gap-2 mt-3">
                <Button variant="ghost" size="sm" onClick={() => setShowOverwrite(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="accent" size="sm" onClick={() => doExport(true)} disabled={busy}>
                  {busy ? 'Exporting…' : 'Overwrite'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2 mt-5">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="accent" size="sm" onClick={handleConfirm} disabled={busy}>
                {busy ? 'Exporting…' : 'Export'}
              </Button>
            </div>
          )}
      </DialogContent>
    </Dialog>
  )
}
