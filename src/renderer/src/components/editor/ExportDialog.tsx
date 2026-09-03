import React, { useEffect, useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useDocument } from '../../hooks/useDocuments'
import { exportDocument, resolveTheme } from '../../lib/export'
import { getExportHtml } from '../../lib/exportStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { useT } from '../../i18n'

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
  const { t } = useT()
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

  // Reset state and provide a default target path when the dialog opens. The setState calls are
  // deferred via setTimeout so they aren't synchronous within the effect body (avoids cascading
  // re-renders; satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    if (open) {
      const id = setTimeout(() => {
        setThemeChoice('current')
        setEmbedImages(true)
        setError(null)
        setShowOverwrite(false)
        setTargetPath(doc ? defaultHtmlPath(doc.filePath, doc.title) : null)
      }, 0)
      return () => clearTimeout(id)
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

  // Perform the actual write. No need to pause any watcher around it: the main
  // process ignores the export artefacts it produces (.html/.pdf/.docx) when
  // watching, so writing a sibling .html cannot raise a bogus "file changed".
  const doExport = async (overwrite: boolean): Promise<void> => {
    /* v8 ignore next -- unreachable: handleConfirm only calls doExport after guarding targetPath */
    if (!targetPath) return
    setBusy(true)
    setError(null)
    // Hard lock: mark exporting for the whole write; the store-level closeDocument/closeWorkspace
    // will ignore it, so even triggering the "Close Workspace" shortcut (Cmd/Ctrl+W) won't close
    // the current file/workspace.
    useUIStore.getState().setExporting(true)
    try {
      await exportDocument({
        path: targetPath,
        theme: resolveTheme(themeChoice, uiTheme),
        embedImages,
        overwrite,
      })
      setOpen(false)
    } catch (e) {
      console.error('Export failed', e)
      setError(t('export.failed'))
    } finally {
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
      setError(t('export.previewNotReady'))
      return
    }
    // When the target file already exists, show the inline confirm first (don't call the native
    // window.confirm to avoid accidentally closing the workspace). If the user chose "Overwrite"
    // in the inline confirm, showOverwrite is true and we write directly with overwrite=true.
    /* v8 ignore next -- when showOverwrite is true the UI renders only the Overwrite button (calls doExport(true) directly), so handleConfirm is never re-entered and this false branch is unreachable */
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

  // Path shown in the inline "file already exists" prompt. `showOverwrite` is only turned
  // on inside handleConfirm(), and that function has already returned early when
  // targetPath is null — so targetPath is non-null on any render that reaches the prompt.
  // The `?? ''` only narrows its nullable type for TypeScript and is not reachable in
  // tests. (Kept outside the JSX because `v8 ignore` comments are only honoured on plain
  // statements, not inside JSX children.)
  const overwriteTargetPath = targetPath ?? ''

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('export.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Theme */}
          <div>
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">
              {t('export.theme')}
            </label>
            <select
              value={themeChoice}
              onChange={(e) => setThemeChoice(e.target.value as ThemeChoice)}
              className="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="current">{t('export.themeCurrent', { theme: uiTheme })}</option>
              <option value="light">{t('export.themeLight')}</option>
              <option value="dark">{t('export.themeDark')}</option>
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
            {t('export.inlineImages')}
          </label>

          {/* Target path */}
          <div>
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">
              {t('export.saveLocation')}
            </label>
            <div className="flex items-center gap-2">
              <input
                value={targetPath ?? ''}
                readOnly
                placeholder={t('export.notSelected')}
                className="flex-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 outline-none text-[var(--color-text-secondary)] truncate"
              />
              <Button variant="outline" size="sm" onClick={handlePickPath}>
                {t('export.choose')}
              </Button>
            </div>
            <p className="text-2xs text-[var(--color-text-tertiary)] mt-1">
              {t('export.imageNote')}
            </p>
          </div>

          {error && <p className="text-2xs text-red-500">{error}</p>}
        </div>

        {showOverwrite ? (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 mt-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t('export.overwritePrompt', { path: overwriteTargetPath })}
            </p>
            <div className="flex items-center justify-end gap-2 mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowOverwrite(false)}
                disabled={busy}
              >
                {t('export.cancel')}
              </Button>
              <Button variant="accent" size="sm" onClick={() => doExport(true)} disabled={busy}>
                {busy ? t('export.exporting') : t('export.overwrite')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 mt-5">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('export.cancel')}
            </Button>
            <Button variant="accent" size="sm" onClick={handleConfirm} disabled={busy}>
              {busy ? t('export.exporting') : t('export.export')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
