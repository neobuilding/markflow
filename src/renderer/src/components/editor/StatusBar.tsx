import React, { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useDocument, useSetEncoding } from '../../hooks/useDocuments'

// 常用编码列表（状态栏手动切换用，R5）。
const ENCODINGS = [
  'UTF-8',
  'GBK',
  'GB2312',
  'Big5',
  'Shift-JIS',
  'EUC-JP',
  'UTF-16LE',
  'windows-1252',
] as const

// 底部状态栏：显示字数、编码（可切换 / 低置信度提示），以及保存状态提示。
export function StatusBar(): React.ReactElement {
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const dirty = useUIStore((s) => s.dirty)
  const saving = useUIStore((s) => s.saving)
  const printing = useUIStore((s) => s.printing)
  const justSaved = useUIStore((s) => s.justSaved)
  const setJustSaved = useUIStore((s) => s.setJustSaved)

  const { data: doc } = useDocument(activeDocumentId)
  const setEncodingMut = useSetEncoding()
  const [encOpen, setEncOpen] = useState(false)
  const encRef = useRef<HTMLDivElement>(null)

  // R3：状态栏显示换行符（CRLF/LF）。数据源已就绪（documents:eol IPC，无需改类型）。
  const [eol, setEol] = useState<'\r\n' | '\n' | null>(null)
  useEffect(() => {
    if (!doc?.filePath) {
      setEol(null)
      return
    }
    let cancelled = false
    window.api.documents
      .eol(doc.filePath)
      .then((e) => {
        if (!cancelled) setEol(e)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc?.id, doc?.filePath])

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

  // 点击编码胶囊外部关闭下拉
  useEffect(() => {
    if (!encOpen) return
    const onDown = (e: MouseEvent) => {
      if (encRef.current && !encRef.current.contains(e.target as Node)) setEncOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [encOpen])

  const encoding = doc?.encoding ?? 'utf-8'
  const lowConfidence = (doc?.encodingConfidence ?? 1) < 0.6

  const handlePick = async (enc: string): Promise<void> => {
    setEncOpen(false)
    if (!doc || enc.toLowerCase() === encoding.toLowerCase()) return
    try {
      await setEncodingMut.mutateAsync({ id: doc.id, encoding: enc })
    } catch (e) {
      console.error('Set encoding failed', e)
    }
  }

  let status: React.ReactNode = null
  if (printing) {
    status = <span className="text-2xs text-[var(--color-text-tertiary)]">Printing…</span>
  } else if (saving) {
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

      {/* 编码胶囊（R5）：点击切换；低置信度显示 ⚠ */}
      {doc && (
        <div className="relative ml-3" ref={encRef}>
          <button
            onClick={() => setEncOpen((v) => !v)}
            title={lowConfidence ? '编码可能检测不准，点击切换' : `编码：${encoding}`}
            className={
              'text-2xs px-1.5 py-0.5 rounded border transition-colors ' +
              (lowConfidence
                ? 'border-amber-500/60 text-amber-500 hover:bg-amber-500/10'
                : 'border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]')
            }
          >
            {encoding.toUpperCase()}
            {lowConfidence && ' ⚠'}
          </button>
          {encOpen && (
            <div className="absolute bottom-full left-0 mb-1 z-50 min-w-[120px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1">
              {ENCODINGS.map((enc) => (
                <button
                  key={enc}
                  onClick={() => handlePick(enc)}
                  className={
                    'w-full text-left px-3 py-1 text-2xs hover:bg-[var(--color-accent-muted)] ' +
                    (enc.toLowerCase() === encoding.toLowerCase()
                      ? 'text-accent font-medium'
                      : 'text-[var(--color-text-secondary)]')
                  }
                >
                  {enc}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 换行符胶囊（R3）：只读，与编码胶囊并列 */}
      {eol && (
        <span
          className="text-2xs px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-tertiary)] ml-3"
          title="换行符"
        >
          {eol === '\r\n' ? 'CRLF' : 'LF'}
        </span>
      )}

      <div className="flex items-center gap-3 ml-3">{status}</div>
    </div>
  )
}
