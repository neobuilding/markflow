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

  // 打开时重置状态，并给出默认目标路径
  useEffect(() => {
    if (open) {
      setThemeChoice('current')
      setEmbedImages(true)
      setError(null)
      setTargetPath(doc ? defaultHtmlPath(doc.filePath, doc.title) : null)
    }
  }, [open, doc])

  const handlePickPath = async (): Promise<void> => {
    const def = doc ? defaultHtmlPath(doc.filePath, doc.title) : 'export.html'
    try {
      const p = await window.api.dialog.saveHtmlFile(def)
      if (p) setTargetPath(p)
    } catch {
      /* 取消 */
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!targetPath) {
      await handlePickPath()
      return
    }
    if (!getExportHtml()) {
      setError('预览尚未就绪，请先切换到预览/拆分视图。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await exportDocument({
        path: targetPath,
        theme: resolveTheme(themeChoice, uiTheme),
        embedImages,
      })
      setOpen(false)
    } catch (e) {
      console.error('Export failed', e)
      setError('导出失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export as HTML</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 主题 */}
          <div>
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">主题</label>
            <select
              value={themeChoice}
              onChange={(e) => setThemeChoice(e.target.value as ThemeChoice)}
              className="w-full text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="current">当前（{uiTheme}）</option>
              <option value="light">浅色</option>
              <option value="dark">暗色</option>
            </select>
          </div>

          {/* 内联图片 */}
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={embedImages}
              onChange={(e) => setEmbedImages(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            内联图片为单文件（base64，离线可用）
          </label>

          {/* 目标路径 */}
          <div>
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">保存位置</label>
            <div className="flex items-center gap-2">
              <input
                value={targetPath ?? ''}
                readOnly
                placeholder="未选择"
                className="flex-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 outline-none text-[var(--color-text-secondary)] truncate"
              />
              <Button variant="outline" size="sm" onClick={handlePickPath}>
                选择…
              </Button>
            </div>
            <p className="text-2xs text-[var(--color-text-tertiary)] mt-1">
              不内联时，本地图片会改写为相对路径（与 .html 同目录分发），远程 https 图保留。
            </p>
          </div>

          {error && <p className="text-2xs text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="accent" size="sm" onClick={handleConfirm} disabled={busy}>
            {busy ? '导出中…' : '导出'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
