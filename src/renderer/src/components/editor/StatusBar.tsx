import React, { useEffect, useRef, useState } from 'react'
import { Copy, Save, SaveAll, RotateCcw } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useDocument, useSetEncoding, useSetEol, useReloadDocument } from '../../hooks/useDocuments'
import { useT } from '../../i18n'
import { baseName } from '../../lib/utils'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
} from '../ui/context-menu'

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
  // "Save" is a no-op in read-only mode (EditorPane.handleSave returns early), so
  // the menu item has to grey out under the same condition as the toolbar save button.
  const editable = useUIStore((s) => s.editable)
  // Save / Save As / Reload live in EditorPane; the status bar only requests them
  const requestFileAction = useUIStore((s) => s.requestFileAction)

  const { data: doc } = useDocument(activeDocumentId)
  const setEncodingMut = useSetEncoding()
  const setEolMut = useSetEol()
  const reloadMut = useReloadDocument()
  const [encOpen, setEncOpen] = useState(false)
  const encRef = useRef<HTMLDivElement>(null)
  // EOL pill dropdown : click to switch line endings on disk
  const [eolOpen, setEolOpen] = useState(false)
  const eolRef = useRef<HTMLDivElement>(null)
  const [redetecting, setRedetecting] = useState(false)

  const copyText = (text: string) => {
    void window.api.clipboard.writeText(text)
  }

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

  // Re-detect the file's encoding from disk and apply it. The pill
  // is shown for files only; a draft (no filePath) can't be re-detected.
  const handleRedetect = async (): Promise<void> => {
    // The re-detect button is disabled for drafts (no filePath), so this guard is
    // purely defensive v8 can't reach it through the UI
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

  // Switch line endings on disk . Destructive write: the renderer must
  // confirm first and reload afterwards. We perform the write, then reload the document
  // from disk so the buffer reflects the new line endings. The confirmation is asked on
  // BOTH paths (the left-click dropdown and the right-click menu) the rewrite discards
  // unsaved changes, so neither path may skip it.
  const handleSwitchEol = async (next: '\r\n' | '\n'): Promise<void> => {
    // The pill only renders for files and the matching switch button is disabled, so
    // this guard is defensive v8 can't reach it through the UI
    /* v8 ignore next */
    if (!doc?.filePath || !eol || eol === next) {
      setEolOpen(false)
      return
    }
    setEolOpen(false)
    const ok = await window.api.dialog.confirm({
      message: t('app.switchEolConfirm', { eol: next === '\r\n' ? 'CRLF' : 'LF' }),
      detail: t('app.switchEolDetail'),
      okText: t('app.switchEolOk'),
      cancelText: t('app.cancel'),
    })
    if (!ok) return
    try {
      await setEolMut.mutateAsync({ filePath: doc.filePath, eol: next })
      setEol(next)
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
      {/* Word count The whole bar is `user-select: none`, so right-click "Copy word count" is the only way to get the number out. tabIndex makes the plain <span> reachable for Shift+F10 (G11) */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <span
            tabIndex={0}
            data-testid="status-word-count"
            className="text-2xs text-[var(--color-text-tertiary)] outline-none"
          >
            {doc ? t('status.words', { wordCount: doc.wordCount }) : ''}
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            data-testid="sb-copy-word-count"
            disabled={!doc}
            onClick={() => doc && copyText(String(doc.wordCount))}
          >
            <Copy size={13} /> {t('ctx.copyWordCount')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid="sb-copy-path"
            disabled={!doc?.filePath}
            onClick={() => copyText(doc?.filePath as string)}
          >
            <Copy size={13} /> {t('editor.copyFullPath')}
          </ContextMenuItem>
          <ContextMenuItem
            data-testid="sb-copy-filename"
            disabled={!doc?.filePath}
            onClick={() => copyText(baseName(doc?.filePath as string))}
          >
            <Copy size={13} /> {t('editor.copyFileName')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Encoding pill (R5): click to switch; show ⚠ on low confidence */}
      {doc && (
        <div className="relative ml-3" ref={encRef}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                data-testid="status-encoding"
                onClick={() => setEncOpen((v) => !v)}
                title={
                  lowConfidence
                    ? t('status.encodingInaccurate')
                    : t('status.encoding', { encoding })
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
            </ContextMenuTrigger>
            {/* the nine encodings are FLAT (no submenu, per 4) with the active one ticked. This menu is independent of the left-click dropdown: `encOpen` is only toggled by the button, never by this menu */}
            <ContextMenuContent>
              {ENCODINGS.map((enc) => (
                <ContextMenuCheckboxItem
                  key={enc}
                  data-testid={`sb-encoding-${enc}`}
                  checked={enc.toLowerCase() === encoding.toLowerCase()}
                  onSelect={() => void handlePick(enc)}
                >
                  {enc}
                </ContextMenuCheckboxItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="sb-redetect-encoding"
                disabled={!doc?.filePath || redetecting}
                onClick={() => void handleRedetect()}
              >
                <RotateCcw size={13} /> {t('ctx.redetectEncoding')}
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="sb-copy-encoding"
                onClick={() => copyText(encoding.toUpperCase())}
              >
                <Copy size={13} /> {t('ctx.copyEncoding')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
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
              {/* Re-detect encoding from disk , only meaningful for files */}
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

      {/* Line-ending pill (R3 / ): click to switch CRLF <-> LF on disk */}
      {eol && (
        <div className="relative ml-3" ref={eolRef}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                data-testid="status-eol"
                onClick={() => setEolOpen((v) => !v)}
                title={t('status.lineEndingSwitch')}
                className="text-2xs px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
              >
                {eol === '\r\n' ? 'CRLF' : 'LF'}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                data-testid="sb-switch-crlf"
                disabled={eol === '\r\n'}
                onClick={() => void handleSwitchEol('\r\n')}
              >
                {t('ctx.switchToCrlf')}
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="sb-switch-lf"
                disabled={eol === '\n'}
                onClick={() => void handleSwitchEol('\n')}
              >
                {t('ctx.switchToLf')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="sb-copy-line-ending"
                onClick={() => copyText(eol === '\r\n' ? 'CRLF' : 'LF')}
              >
                <Copy size={13} /> {t('ctx.copyLineEnding')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
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

      {/* Save status region The save handlers live in EditorPane (they need the local draft), so the items only request them through the store bridge. The region is `flex-1` so the otherwise empty right end of the bar is still a right-click target; tabIndex keeps it keyboard-reachable (G11) */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            tabIndex={0}
            data-testid="status-save-region"
            className="flex items-center gap-3 ml-3 flex-1 outline-none"
          >
            {status}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            data-testid="sb-save"
            disabled={!editable || !dirty || !doc}
            title={!editable ? t('editor.needsEditMode') : undefined}
            onClick={() => requestFileAction({ type: 'save' })}
          >
            <Save size={13} /> {t('editor.save')}
          </ContextMenuItem>
          <ContextMenuItem
            data-testid="sb-save-as"
            disabled={!editable || !doc}
            title={!editable ? t('editor.needsEditMode') : undefined}
            onClick={() => requestFileAction({ type: 'saveAs' })}
          >
            <SaveAll size={13} /> {t('editor.saveAs')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid="sb-reload"
            disabled={!doc?.filePath}
            onClick={() => requestFileAction({ type: 'reload' })}
          >
            <RotateCcw size={13} /> {t('editor.reload')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
