import React, { useState } from 'react'
import { FileText } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useCreateDocument } from '../../hooks/useDocuments'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { useT } from '../../i18n'

export function NewDocumentDialog(): React.ReactElement {
  const { t } = useT()
  const { newDocOpen, setNewDocOpen, setActiveDocumentId, setEditable, setIsNewUnsaved } =
    useUIStore()
  const [title, setTitle] = useState('')
  const [ext, setExt] = useState('.md')
  const createMut = useCreateDocument()

  const handleCreate = async () => {
    const finalTitle = title.trim() || 'Untitled'
    const doc = await createMut.mutateAsync({ title: finalTitle, ext })
    setActiveDocumentId(doc.id)
    setEditable(true) // new documents are editable by default
    setIsNewUnsaved(true) // first Save will prompt for a path
    setTitle('')
    setNewDocOpen(false)
  }

  return (
    <Dialog open={newDocOpen} onOpenChange={setNewDocOpen}>
      <DialogContent>
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
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('new.untitled')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') setNewDocOpen(false)
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              {t('new.extension')}
            </label>
            <select
              value={ext}
              onChange={(e) => setExt(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              <option value=".md">.md</option>
              <option value=".mdx">.mdx</option>
              <option value=".markdown">.markdown</option>
              <option value=".mdtxt">.mdtxt</option>
              <option value=".mdtext">.mdtext</option>
            </select>
          </div>
          <div className="flex items-center justify-end gap-2">
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
