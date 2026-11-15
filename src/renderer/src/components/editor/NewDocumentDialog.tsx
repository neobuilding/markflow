import React, { useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useCreateDocument } from '../../hooks/useDocuments'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { Button } from '../ui/button'
import { useT } from '../../i18n'
import { InputContextMenu } from '../ui/input-context-menu'
import {
  invalidBaseName,
  isAlreadyExistsError,
  joinPath,
  resolveNewFileTarget,
} from '../../lib/utils'
import { MD_EXTS } from '../../../../../shared/fileUtils'

// "New File…" (File menu) creates a REAL Markdown file in the open folder — the VS Code
// "New File…" counterpart to the always-available, memory-only "New Draft" (Ctrl/Cmd+N).
// It is deliberately the only consumer of `newDocOpen`; the dialog is not a draft creator.
//
// Validation mirrors the sidebar's inline "New File" row: refuse an invalid base name, and
// refuse a name that already exists BEFORE writing. The main process still creates with O_EXCL,
// so a race between the stat() pre-check and the write is caught as EEXIST in the catch below.

const EXTS = [...MD_EXTS]

export function NewDocumentDialog(): React.ReactElement {
  const { t } = useT()
  // Field-scoped selectors: an identity selector re-renders on every keystroke (ADR-0033).
  const newDocOpen = useUIStore((s) => s.newDocOpen)
  const activeFolder = useUIStore((s) => s.activeFolder)
  // Actions are stable references created once by the store initializer, so reading them via
  // getState() avoids an unnecessary subscription (Vercel rerender-defer-reads).
  const { setNewDocOpen, setActiveDocumentId, setEditable, setIsNewUnsaved } = useUIStore.getState()
  const [title, setTitle] = useState('')
  // Ref for the right-click edit menu
  const titleRef = useRef<HTMLInputElement>(null)
  const [ext, setExt] = useState('.md')
  const [error, setError] = useState<string | null>(null)
  const createMut = useCreateDocument()

  // Close through here rather than `setNewDocOpen(false)` directly: the dialog is mounted for the
  // whole session, so a cancelled attempt would otherwise reopen with the previous name, extension
  // and error banner still in place.
  const closeDialog = (open: boolean): void => {
    if (!open) {
      setTitle('')
      setExt('.md')
      setError(null)
    }
    setNewDocOpen(open)
  }

  const handleCreate = async () => {
    // The Create button is disabled while pending, but Enter is a second, un-guarded path to this
    // function: a double Enter would fire two creates, and the loser's EEXIST would be reported
    // after the dialog had already closed.
    if (createMut.isPending) return
    if (!activeFolder) {
      setError(t('new.noFolder'))
      return
    }
    const finalTitle = title.trim() || 'Untitled'
    if (invalidBaseName(finalTitle)) {
      setError(t('new.invalidName', { name: finalTitle }))
      return
    }
    // ADR-0011: the typed name decides the file name. A Markdown extension typed into the field is
    // used as typed (never doubled into `notes.md.md`), an unsupported one is refused rather than
    // written as an unopenable `notes.txt.md`, and only a bare name falls back to the selector.
    const target = resolveNewFileTarget(finalTitle, ext)
    if (!target) {
      setError(t('new.unsupportedExt', { name: finalTitle }))
      return
    }
    const fileName = `${target.title}${target.ext}`
    // Guard BEFORE creating (ADR-0023 §5.9): the new document does not exist yet, so there is no
    // id to hand to `selectDocument`. Creating first and switching afterwards would drop the
    // current document's unsaved edits AND leave an orphan file behind if the user then declines.
    if (!(await useUIStore.getState().guardUnsavedSwitch())) return
    setError(null)
    try {
      const existing = await window.api.documents.stat(joinPath(activeFolder, fileName))
      if (existing?.exists) {
        setError(t('new.nameExists', { name: fileName }))
        return
      }
      const doc = await createMut.mutateAsync({
        title: target.title,
        ext: target.ext,
        folderPath: activeFolder,
        memoryOnly: false,
      })
      // Raw setter is correct here: the guard has already been obtained (same as Sidebar's inline
      // create row), and the new document is empty so there is nothing to discard.
      setActiveDocumentId(doc.id)
      setEditable(true) // new documents are editable by default
      setIsNewUnsaved(false) // the file already exists on disk; Save must not ask for a path
      setTitle('')
      setNewDocOpen(false)
    } catch (e) {
      // `documents:create` uses O_EXCL, so a concurrent create surfaces here even when stat()
      // said the name was free. Never leave the user staring at a dialog with no explanation.
      setError(
        isAlreadyExistsError(e)
          ? t('new.nameExists', { name: fileName })
          : t('new.createFailed', { message: (e as Error)?.message || String(e) }),
      )
      console.error('New File failed', e)
    }
  }

  return (
    <Dialog open={newDocOpen} onOpenChange={closeDialog}>
      <DialogContent data-testid="new-document-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText size={16} className="text-accent" />
            {t('new.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              {t('new.documentTitle')}
            </label>
            {/* Right-click edit menu */}
            <InputContextMenu targetRef={titleRef}>
              <Input
                ref={titleRef}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  if (error) setError(null)
                }}
                placeholder={t('new.untitled')}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate()
                  if (e.key === 'Escape') closeDialog(false)
                }}
              />
            </InputContextMenu>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              {t('new.extension')}
            </label>
            <Select value={ext} onChange={(e) => setExt(e.target.value)}>
              {EXTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          {error && (
            <p
              className="text-2xs text-[var(--color-danger-text)]"
              role="alert"
              data-testid="new-file-error"
            >
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            <Button variant="ghost" size="sm" onClick={() => closeDialog(false)}>
              {t('new.cancel')}
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => void handleCreate()}
              disabled={createMut.isPending || !activeFolder}
            >
              {t('new.create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
