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

export function NewDocumentDialog(): React.ReactElement {
  const { t } = useT()
  const { newDocOpen, setNewDocOpen, setActiveDocumentId, setEditable, setIsNewUnsaved } =
    useUIStore()
  const [title, setTitle] = useState('')
  // Ref for the right-click edit menu
  const titleRef = useRef<HTMLInputElement>(null)
  const [ext, setExt] = useState('.md')
  const createMut = useCreateDocument()

  const handleCreate = async () => {
    // Guard BEFORE creating (ADR-0023 §5.9): the new document does not exist yet, so there is no
    // id to hand to `selectDocument`. Creating first and switching afterwards would drop the
    // current document's unsaved edits AND leave an orphan draft behind if the user then declines.
    if (!(await useUIStore.getState().guardUnsavedSwitch())) return
    const finalTitle = title.trim() || 'Untitled'
    const doc = await createMut.mutateAsync({ title: finalTitle, ext })
    // Raw setter is correct here: the guard has already been obtained (same as Sidebar's inline
    // create row), and the new document is empty so there is nothing to discard.
    setActiveDocumentId(doc.id)
    setEditable(true) // new documents are editable by default
    setIsNewUnsaved(true) // first Save will prompt for a path
    setTitle('')
    setNewDocOpen(false)
  }

  return (
    <Dialog open={newDocOpen} onOpenChange={setNewDocOpen}>
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
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('new.untitled')}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') setNewDocOpen(false)
                }}
              />
            </InputContextMenu>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              {t('new.extension')}
            </label>
            <Select value={ext} onChange={(e) => setExt(e.target.value)}>
              <option value=".md">.md</option>
              <option value=".mdx">.mdx</option>
              <option value=".markdown">.markdown</option>
              <option value=".mdtxt">.mdtxt</option>
              <option value=".mdtext">.mdtext</option>
            </Select>
          </div>
          <div className="flex items-center justify-end gap-3">
            <Button variant="ghost" size="sm" onClick={() => setNewDocOpen(false)}>
              {t('new.cancel')}
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={handleCreate}
              disabled={createMut.isPending}
            >
              {t('new.create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
