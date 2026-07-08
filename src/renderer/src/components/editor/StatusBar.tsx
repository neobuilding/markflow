import React, { useEffect } from 'react'
import { useUIStore } from '../../store/ui'
import { useDocument } from '../../hooks/useDocuments'

// 底部状态栏：显示字数，以及在“保存/未保存”时短暂出现的保存状态提示。
export function StatusBar(): React.ReactElement {
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const dirty = useUIStore((s) => s.dirty)
  const saving = useUIStore((s) => s.saving)
  const justSaved = useUIStore((s) => s.justSaved)
  const setJustSaved = useUIStore((s) => s.setJustSaved)

  const { data: doc } = useDocument(activeDocumentId)

  // “✓ Saved” 提示在延迟后自动消失
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(false), 2000)
    return () => clearTimeout(t)
  }, [justSaved, setJustSaved])

  // 切换文档时清除“已保存”提示
  useEffect(() => {
    setJustSaved(false)
  }, [activeDocumentId, setJustSaved])

  let status: React.ReactNode = null
  if (saving) {
    status = <span className="text-2xs text-[var(--color-text-tertiary)]">Saving…</span>
  } else if (dirty) {
    status = <span className="text-2xs text-amber-500">● Unsaved changes</span>
  } else if (justSaved) {
    status = <span className="text-2xs text-[var(--color-success)]">✓ Saved</span>
  }

  return (
    <div className="flex items-center px-4 py-0.5 border-t border-[var(--color-border)] bg-[var(--color-bg)] shrink-0">
      <span className="text-2xs text-[var(--color-text-tertiary)]">
        {doc ? `${doc.wordCount} words` : ''}
      </span>
      <div className="flex items-center gap-3 ml-3">{status}</div>
    </div>
  )
}
