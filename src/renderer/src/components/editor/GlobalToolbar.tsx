import React from 'react'
import { FileText, Save, SaveAll, RotateCcw, Info, FileOutput, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useT } from '../../i18n'
import { useUIStore } from '../../store/ui'
import { formatShortcut } from '../../lib/utils'

interface GlobalToolbarProps {
  onSave: () => void
  onSaveAs: () => void
  onReload: () => void
  onClose: () => void
  savePending: boolean
  saveAsPending: boolean
  reloadPending: boolean
}

/**
 * The global (cross-pane) command bar, extracted from `EditorPane` (Q8) so the editor panel and the
 * global toolbar are separate components. It owns APP-LEVEL actions — quick open, save / save-as /
 * reload / file details / export / close — not editor-pane internals. The `global-bar` element it
 * renders is the de-facto single title-bar row (App mounts exactly one EditorPane), so this bar is a
 * singleton across all view modes. The meaty save/reload handlers are passed in as props; only the
 * read-only / document / view-mode state it needs for rendering is read from the store directly.
 */
export function GlobalToolbar({
  onSave,
  onSaveAs,
  onReload,
  onClose,
  savePending,
  saveAsPending,
  reloadPending,
}: GlobalToolbarProps): React.ReactElement {
  const { t } = useT()
  const editable = useUIStore((s) => s.editable)
  const dirty = useUIStore((s) => s.dirty)
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const viewMode = useUIStore((s) => s.viewMode)

  return (
    <div className="titlebar-no-drag flex items-center gap-1.5">
      {/* "Go to file…" — the Quick Open trigger (ADR-0023). It is the FIRST entry of the global
          toolbar — the sidebar toggle that used to sit before it was removed (Q2a) — and its tooltip
          NAMES the surface's scope ("Go to file…"), so the entry point says what it searches
          instead of showing a bare magnifier. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            aria-label={t('sidebar.goToFile')}
            data-testid="editor-goto-file-btn"
            onClick={() => useUIStore.getState().setSearchOpen(true)}
          >
            <FileText size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('editor.goToFileShortcut', { shortcut: formatShortcut('⌘⇧K') })}
        </TooltipContent>
      </Tooltip>
      {/* Save / Save As / Reload grouped with Open/Close as file operations, kept on the left */}
      {activeDocumentId && (
        <>
          {/* Cluster boundary: navigation/search ↔ file operations. It lives INSIDE the
              `activeDocumentId` gate on purpose — otherwise the empty state would show a lone
              divider floating between the ⌘K chip and Close. */}
          <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="toolbar"
                size="icon"
                onClick={onSave}
                disabled={!editable || !dirty || savePending || saveAsPending}
                className={editable && dirty ? 'text-accent' : ''}
                data-testid="save-btn"
              >
                <Save size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editable
                ? dirty
                  ? t('editor.saveShortcut', { shortcut: formatShortcut('⌘S') })
                  : t('editor.noChanges')
                : t('editor.saveSwitchEdit')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="toolbar"
                size="icon"
                onClick={onSaveAs}
                disabled={!editable || saveAsPending}
                data-testid="save-as-btn"
              >
                <SaveAll size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editable
                ? t('editor.saveAsShortcut', { shortcut: formatShortcut('⌘⇧S') })
                : t('editor.saveAsSwitchEdit')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="toolbar"
                size="icon"
                onClick={onReload}
                disabled={reloadPending}
                data-testid="reload-btn"
              >
                <RotateCcw size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('editor.reloadShortcut', { shortcut: formatShortcut('⌘⇧R') })}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="toolbar"
                size="icon"
                onClick={() =>
                  activeDocumentId && useUIStore.getState().setFileDetailsId(activeDocumentId)
                }
                data-testid="file-details-btn"
              >
                <Info size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('editor.fileDetailsShortcut', { shortcut: formatShortcut('⌘⇧I') })}
            </TooltipContent>
          </Tooltip>

          {/* Export follows the preview's visibility (ADR-0024 §10 trade-off 46): when the preview is
              visible the export button lives on the preview pane bar; in edit-only mode it stays here.
              Exactly one export button is on screen at a time. */}
          {viewMode === 'edit' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="toolbar"
                  size="icon"
                  onClick={() => useUIStore.getState().setExportOpen(true)}
                  data-testid="export-btn"
                >
                  <FileOutput size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('editor.exportShortcut', { shortcut: formatShortcut('⌘⇧X') })}
              </TooltipContent>
            </Tooltip>
          )}

          <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="toolbar" size="icon" onClick={onClose} data-testid="close-btn">
            <X size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('editor.closeFile')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
