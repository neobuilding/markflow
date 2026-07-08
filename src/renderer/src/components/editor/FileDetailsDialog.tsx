import React, { useState } from 'react'
import { FileText, Copy, FolderOpen, Clock, Calendar, Hash, Info } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useDocument, useFileStat } from '../../hooks/useDocuments'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { formatFileSize, formatDateTime } from '../../lib/utils'

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <div className="mt-0.5 text-[var(--color-text-tertiary)] shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-2xs uppercase tracking-wide text-[var(--color-text-tertiary)]">{label}</div>
        <div className="text-sm text-[var(--color-text-primary)] break-all mt-0.5">{children}</div>
      </div>
    </div>
  )
}

export function FileDetailsDialog(): React.ReactElement | null {
  const fileDetailsId = useUIStore((s) => s.fileDetailsId)
  const setFileDetailsId = useUIStore((s) => s.setFileDetailsId)
  const { data: doc } = useDocument(fileDetailsId)
  const { data: stat } = useFileStat(doc?.filePath)
  const [copied, setCopied] = useState(false)

  const open = fileDetailsId !== null

  const close = () => {
    setFileDetailsId(null)
    setCopied(false)
  }

  const copyPath = async () => {
    if (!doc?.filePath) return
    try {
      await navigator.clipboard.writeText(doc.filePath)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 忽略剪贴板不可用的情况
    }
  }

  const showInFolder = () => {
    if (doc?.filePath) window.api.app.showInFolder(doc.filePath)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info size={16} className="text-accent" />
            File Details
          </DialogTitle>
        </DialogHeader>

        {doc && (
          <div className="divide-y divide-[var(--color-border)]">
            <Row icon={<FileText size={14} />} label="Title">
              {doc.title}
            </Row>

            <Row icon={<FileText size={14} />} label="Path">
              <span className="font-mono text-xs">{doc.filePath}</span>
              <div className="flex items-center gap-2 mt-1.5">
                <Button variant="outline" size="sm" onClick={copyPath} className="gap-1">
                  <Copy size={12} /> {copied ? 'Copied' : 'Copy path'}
                </Button>
                <Button variant="outline" size="sm" onClick={showInFolder} className="gap-1">
                  <FolderOpen size={12} /> Show in folder
                </Button>
              </div>
            </Row>

            <Row icon={<Hash size={14} />} label="Size">
              {stat?.exists ? formatFileSize(stat.size) : '—'}
            </Row>

            <Row icon={<Calendar size={14} />} label="Created">
              {stat?.exists ? formatDateTime(stat.createdAt) : '—'}
            </Row>

            <Row icon={<Clock size={14} />} label="Modified">
              {stat?.exists ? formatDateTime(stat.updatedAt) : formatDateTime(doc.updatedAt)}
            </Row>

            <Row icon={<Hash size={14} />} label="Word count">
              {doc.wordCount} words
            </Row>
          </div>
        )}

        <div className="flex items-center justify-end mt-4">
          <Button variant="accent" size="sm" onClick={close}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
