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
  const { newDocOpen, setNewDocOpen, setActiveDocumentId, setEditable } = useUIStore()
  const [title, setTitle] = useState('')
  const createMut = useCreateDocument()

  const handleCreate = async () => {
    const finalTitle = title.trim() || 'Untitled'
    const doc = await createMut.mutateAsync({ title: finalTitle })
    setActiveDocumentId(doc.id)
    setEditable(true) // new documents are editable by default
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
