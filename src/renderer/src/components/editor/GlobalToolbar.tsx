import React from 'react'
import { FileInput, FileText, Save, SaveAll, RotateCcw, Info, FileOutput, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useT } from '../../i18n'
import { useUIStore, selectFileLocked } from '../../store/ui'
import { formatShortcut } from '../../lib/utils'
import { createDraft, useHasMemoryOnlyDraft } from '../../hooks/useDocuments'

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
  // R5 plan A: while the system print dialog is up, every document transaction here is refused
  // by the store. Mirror that guard in the UI so the buttons LOOK disabled instead of silently
  // swallowing clicks. Subscribing to the single flag (not the whole store) keeps renders cheap.
  const fileLocked = useUIStore(selectFileLocked)
  // At most one unsaved draft: once a memory-only document exists, New Draft can't make another, so
  // the button is disabled. `createDraft` (keyboard) and the native File > New Draft item read the
  // same rule, so no entry point can disagree.
  const draftExists = useHasMemoryOnlyDraft()

  return (
    <div className="titlebar-no-drag flex items-center gap-1.5">
      {/* "Go to file…" — the Quick Open trigger (ADR-0023). It is the FIRST entry of the global
          toolbar — the sidebar toggle that used to sit before it was removed (Q2a). It wears a
          "jump into a file" arrow glyph (FileInput) rather than a document glyph: a bare document
          reads as "create a new file", which is exactly what the button NEXT to it does. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            aria-label={t('sidebar.goToFile')}
            data-testid="editor-goto-file-btn"
            disabled={fileLocked}
            onClick={() => useUIStore.getState().setSearchOpen(true)}
          >
            <FileInput size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('editor.goToFileShortcut', { shortcut: formatShortcut('⌘⇧K') })}
        </TooltipContent>
      </Tooltip>
      {/* "New Draft" — the always-available, filesystem-independent create action (VS Code's
          Ctrl/Cmd+N "New Text File"). It creates an in-memory draft with no dialog. The FileInput
          glyph above used to be FileText; that document glyph belongs HERE now. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            aria-label={t('sidebar.newDraft')}
            data-testid="new-document-btn"
            disabled={draftExists || fileLocked}
            onClick={() => void createDraft()}
          >
            <FileText size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('sidebar.newDraft')} ({formatShortcut('⌘N')})
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
                disabled={!editable || !dirty || savePending || saveAsPending || fileLocked}
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
                disabled={!editable || saveAsPending || fileLocked}
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
                disabled={reloadPending || fileLocked}
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
                disabled={fileLocked}
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
                  disabled={fileLocked}
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
          {/* Close lives INSIDE the `activeDocumentId` gate on purpose: with no document open
              there is nothing to close, so the button must disappear (matching the rest of the
              file-operations cluster) rather than sit there inert. The native menu item takes the
              complementary path — it stays present but is disabled (see electron/main/menu.ts). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="toolbar"
                size="icon"
                onClick={onClose}
                data-testid="close-btn"
                disabled={fileLocked}
              >
                <X size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('editor.closeFile')}</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  )
}
