import React, { useState } from 'react'
import { FileText, Copy, FolderOpen, Clock, Calendar, Hash, Info } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useDocument, useFileStat } from '../../hooks/useDocuments'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { baseName, formatFileSize, formatDateTime } from '../../lib/utils'
import { useT } from '../../i18n'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../ui/context-menu'

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <div className="mt-0.5 text-[var(--color-text-tertiary)] shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-2xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {label}
        </div>
        <div className="text-sm text-[var(--color-text-primary)] break-all mt-0.5">{children}</div>
      </div>
    </div>
  )
}

export function FileDetailsDialog(): React.ReactElement | null {
  const { t } = useT()
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
    /* v8 ignore next -- defensive: the Copy button only renders when doc.filePath exists, so this null branch is unreachable */
    if (!doc?.filePath) return
    try {
      await window.api.clipboard.writeText(doc.filePath)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Ignore when the clipboard is unavailable
    }
  }

  // The dialog has buttons for the other two path actions but none for the bare file
  // name, so the menu carries it. Only reachable when a path exists.
  const copyFileName = async () => {
    /* v8 ignore next -- defensive: the path menu only renders when doc.filePath exists, so this null branch is unreachable */
    if (!doc?.filePath) return
    try {
      await window.api.clipboard.writeText(baseName(doc.filePath))
    } catch {
      // Ignore when the clipboard is unavailable
    }
  }

  const showInFolder = () => {
    /* v8 ignore next -- defensive: the Show-in-Folder button only renders when doc.filePath exists, so this false branch is unreachable */
    if (doc?.filePath) window.api.app.showInFolder(doc.filePath)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        /* v8 ignore next -- the dialog is controlled by the store; Radix only fires onOpenChange(false) on dismiss, so the o=true branch is unreachable (the close test asserts fileDetailsId becomes null) */
        if (!o) close()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info size={16} className="text-accent" />
            {t('details.title')}
          </DialogTitle>
        </DialogHeader>

        {doc && (
          <div className="divide-y divide-[var(--color-border)]">
            <Row icon={<FileText size={14} />} label={t('details.titleField')}>
              {doc.title}
            </Row>

            <Row icon={<FileText size={14} />} label={t('details.path')}>
              {doc.filePath ? (
                <>
                  {/* wrap the path in a right-click menu so the full path / "show in folder" are reachable without hunting for the small buttons below */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <span className="font-mono text-xs" data-testid="file-details-path">
                        {doc.filePath}
                      </span>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        data-testid="fdd-details-copy-path"
                        onClick={() => void copyPath()}
                      >
                        <Copy size={13} /> {t('details.copyPath')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="fdd-details-copy-filename"
                        onClick={() => void copyFileName()}
                      >
                        <Copy size={13} /> {t('editor.copyFileName')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        data-testid="fdd-details-show-in-folder"
                        onClick={() => showInFolder()}
                      >
                        <FolderOpen size={13} /> {t('details.showInFolder')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Button variant="outline" size="sm" onClick={copyPath} className="gap-1">
                      <Copy size={12} /> {copied ? t('about.copied') : t('details.copyPath')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={showInFolder} className="gap-1">
                      <FolderOpen size={12} /> {t('details.showInFolder')}
                    </Button>
                  </div>
                </>
              ) : (
                <span className="text-xs text-[var(--color-text-tertiary)] italic">
                  {t('details.unsaved')}
                </span>
              )}
            </Row>

            <Row icon={<Hash size={14} />} label={t('details.size')}>
              {stat?.exists ? formatFileSize(stat.size) : '—'}
            </Row>

            <Row icon={<Calendar size={14} />} label={t('details.created')}>
              {stat?.exists ? formatDateTime(stat.createdAt) : '—'}
            </Row>

            <Row icon={<Clock size={14} />} label={t('details.modified')}>
              {stat?.exists ? formatDateTime(stat.updatedAt) : formatDateTime(doc.updatedAt)}
            </Row>

            <Row icon={<Hash size={14} />} label={t('details.wordCount')}>
              {t('details.words', { wordCount: doc.wordCount })}
            </Row>
          </div>
        )}

        <div className="flex items-center justify-end mt-4">
          <Button variant="accent" size="sm" onClick={close}>
            {t('details.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
