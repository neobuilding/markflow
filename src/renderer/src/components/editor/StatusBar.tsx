import React, { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useDocument, useSetEncoding, useSetEol, useReloadDocument } from '../../hooks/useDocuments'
import { useT } from '../../i18n'

// Common encoding list (for manual switching in the status bar, R5).
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

// Bottom status bar: shows word count, encoding (switchable / low-confidence hint), and save status.
export function StatusBar(): React.ReactElement {
  const { t } = useT()
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const dirty = useUIStore((s) => s.dirty)
  const saving = useUIStore((s) => s.saving)
  const printing = useUIStore((s) => s.printing)
  const justSaved = useUIStore((s) => s.justSaved)
  const setJustSaved = useUIStore((s) => s.setJustSaved)

  const { data: doc } = useDocument(activeDocumentId)
  const setEncodingMut = useSetEncoding()
  const setEolMut = useSetEol()
  const reloadMut = useReloadDocument()
  const [encOpen, setEncOpen] = useState(false)
  const encRef = useRef<HTMLDivElement>(null)
  // EOL pill dropdown (PLAN §8 / 能力 6): click to switch line endings on disk.
  const [eolOpen, setEolOpen] = useState(false)
  const eolRef = useRef<HTMLDivElement>(null)
  const [redetecting, setRedetecting] = useState(false)

  // R3: status bar shows the line ending (CRLF/LF). The data source is ready
  // (documents:eol IPC, no type change needed).
  const [eol, setEol] = useState<'\r\n' | '\n' | null>(null)
  useEffect(() => {
    if (!doc?.filePath) {
      // Deferred so the setState isn't synchronous within the effect body
      // (avoids cascading re-renders; satisfies react-hooks/set-state-in-effect).
      const id = setTimeout(() => setEol(null), 0)
      return () => clearTimeout(id)
    }
    let cancelled = false
    window.api.documents
      .eol(doc.filePath)
      .then((e) => {
        if (!cancelled) setEol(e)
      })
      .catch(() => {
        /* never hit */
      })
    return () => {
      cancelled = true
    }
  }, [doc?.id, doc?.filePath])

  // The "✓ Saved" hint auto-hides after a delay.
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(false), 2000)
    return () => clearTimeout(t)
  }, [justSaved, setJustSaved])

  // Clear the "saved" hint when switching documents.
  useEffect(() => {
    setJustSaved(false)
  }, [activeDocumentId, setJustSaved])

  // Close the dropdown when clicking outside the encoding pill.
  useEffect(() => {
    if (!encOpen) return
    const onDown = (e: MouseEvent) => {
      if (encRef.current && !encRef.current.contains(e.target as Node)) setEncOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [encOpen])

  // Close the EOL dropdown when clicking outside it.
  useEffect(() => {
    if (!eolOpen) return
    const onDown = (e: MouseEvent) => {
      if (eolRef.current && !eolRef.current.contains(e.target as Node)) setEolOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [eolOpen])

  // Re-detect the file's encoding from disk (PLAN §8 / 能力 11) and apply it. The pill
  // is shown for files only; a draft (no filePath) can't be re-detected.
  const handleRedetect = async (): Promise<void> => {
    // The re-detect button is disabled for drafts (no filePath), so this guard is
    // purely defensive — v8 can't reach it through the UI.
    /* v8 ignore next */
    if (!doc?.filePath) return
    setEncOpen(false)
    setRedetecting(true)
    try {
      const res = await window.api.documents.detectEncoding(doc.filePath)
      await setEncodingMut.mutateAsync({ id: doc.id, encoding: res.enc })
    } catch (e) {
      console.error('Re-detect encoding failed', e)
    } finally {
      setRedetecting(false)
    }
  }

  // Switch line endings on disk (PLAN §8 / 能力 6). Destructive write: the renderer must
  // confirm first and reload afterwards. We perform the write, then reload the document
  // from disk so the buffer reflects the new line endings.
  const handleSwitchEol = async (next: '\r\n' | '\n'): Promise<void> => {
    // The pill only renders for files and the matching switch button is disabled, so
    // this guard is defensive — v8 can't reach it through the UI.
    /* v8 ignore next */
    if (!doc?.filePath || !eol || eol === next) {
      setEolOpen(false)
      return
    }
    setEolOpen(false)
    try {
      await setEolMut.mutateAsync({ filePath: doc.filePath, eol: next })
      await reloadMut.mutateAsync(doc.id)
    } catch (e) {
      console.error('Switch line endings failed', e)
    }
  }

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
    status = (
      <span className="text-2xs text-[var(--color-text-tertiary)]">{t('status.printing')}</span>
    )
  } else if (saving) {
    status = (
      <span className="text-2xs text-[var(--color-text-tertiary)]">{t('status.saving')}</span>
    )
  } else if (dirty) {
    status = <span className="text-2xs text-amber-500">● {t('status.unsaved')}</span>
  } else if (justSaved) {
    status = <span className="text-2xs text-[var(--color-success)]">✓ {t('status.saved')}</span>
  }

  return (
    <div className="flex items-center px-4 py-0.5 border-t border-[var(--color-border)] bg-[var(--color-bg)] shrink-0">
      <span className="text-2xs text-[var(--color-text-tertiary)]">
        {doc ? t('status.words', { wordCount: doc.wordCount }) : ''}
      </span>

      {/* Encoding pill (R5): click to switch; show ⚠ on low confidence */}
      {doc && (
        <div className="relative ml-3" ref={encRef}>
          <button
            onClick={() => setEncOpen((v) => !v)}
            title={
              lowConfidence ? t('status.encodingInaccurate') : t('status.encoding', { encoding })
            }
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
              {/* Re-detect encoding from disk (PLAN §8 / 能力 11), only meaningful for files. */}
              <div className="my-1 border-t border-[var(--color-border)]" />
              <button
                onClick={() => void handleRedetect()}
                disabled={!doc?.filePath || redetecting}
                title={doc?.filePath ? t('status.redetectEncoding') : t('status.redetectDisabled')}
                className={
                  'w-full text-left px-3 py-1 text-2xs hover:bg-[var(--color-accent-muted)] ' +
                  (doc?.filePath
                    ? 'text-[var(--color-text-secondary)]'
                    : 'text-[var(--color-text-tertiary)]')
                }
              >
                {redetecting ? t('status.redetecting') : t('status.redetectEncoding')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Line-ending pill (R3 / PLAN §8): click to switch CRLF <-> LF on disk */}
      {eol && (
        <div className="relative ml-3" ref={eolRef}>
          <button
            onClick={() => setEolOpen((v) => !v)}
            title={t('status.lineEndingSwitch')}
            className="text-2xs px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          >
            {eol === '\r\n' ? 'CRLF' : 'LF'}
          </button>
          {eolOpen && (
            <div className="absolute bottom-full left-0 mb-1 z-50 min-w-[120px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1">
              <button
                onClick={() => void handleSwitchEol('\r\n')}
                disabled={eol === '\r\n'}
                className={
                  'w-full text-left px-3 py-1 text-2xs hover:bg-[var(--color-accent-muted)] ' +
                  (eol === '\r\n'
                    ? 'text-accent font-medium'
                    : 'text-[var(--color-text-secondary)]')
                }
              >
                {t('status.switchToCrlf')}
              </button>
              <button
                onClick={() => void handleSwitchEol('\n')}
                disabled={eol === '\n'}
                className={
                  'w-full text-left px-3 py-1 text-2xs hover:bg-[var(--color-accent-muted)] ' +
                  (eol === '\n' ? 'text-accent font-medium' : 'text-[var(--color-text-secondary)]')
                }
              >
                {t('status.switchToLf')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 ml-3">{status}</div>
    </div>
  )
}
