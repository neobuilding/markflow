import React, { useEffect, useRef, useCallback, useState } from 'react'
import {
  Edit3, Eye, Columns, Star, Hash, Bold, Italic, Code, Link, List, CheckSquare, PanelLeft,
  GripVertical
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../store/ui'
import { useDocument, useUpdateDocument, useToggleStar } from '../../hooks/useDocuments'
import { MarkdownEditor } from './MarkdownEditor'
import { MarkdownPreview } from '../preview/MarkdownPreview'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useLocalDocument } from '../../hooks/useLocalDocument'
import type { ViewMode } from '../../types'

export function EditorPane(): React.ReactElement {
  const { activeDocumentId, viewMode, setViewMode, sidebarOpen, toggleSidebar } = useUIStore()
  const { data: doc, isLoading } = useDocument(activeDocumentId)
  const updateMut = useUpdateDocument()
  const starMut = useToggleStar()

  // Split view: draggable divider. splitRatio is the editor's width fraction (0–1).
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = localStorage.getItem('markflow-split-ratio')
    return saved ? Math.max(0.2, Math.min(0.8, Number(saved))) : 0.5
  })
  const isSplitDragging = useRef(false)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isSplitDragging.current || !splitContainerRef.current) return
      const rect = splitContainerRef.current.getBoundingClientRect()
      const ratio = (e.clientX - rect.left) / rect.width
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)))
    }
    const onUp = () => {
      if (!isSplitDragging.current) return
      isSplitDragging.current = false
      localStorage.setItem('markflow-split-ratio', String(splitRatio))
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [splitRatio])

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isSplitDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const {
    localContent,
    localTitle,
    setLocalTitle,
    editingTitle,
    setEditingTitle,
    handleContentChange,
    handleTitleSave
  } = useLocalDocument(doc, activeDocumentId, updateMut)

  const insertMarkdown = useCallback((before: string, after: string = '') => {
    document.dispatchEvent(new CustomEvent('markdown:insert', { detail: { before, after } }))
  }, [])

  if (!activeDocumentId) {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-surface)]">
        <Toolbar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          viewMode={viewMode}
          setViewMode={setViewMode}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-[var(--color-accent-muted)] flex items-center justify-center mx-auto mb-4">
              <Edit3 size={28} className="text-accent" />
            </div>
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">No document selected</h2>
            <p className="text-sm text-[var(--color-text-tertiary)]">Select or create a document to get started</p>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--color-surface)]">
        <div className="text-sm text-[var(--color-text-tertiary)]">Loading…</div>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--color-surface)]">
        <div className="text-sm text-[var(--color-text-tertiary)]">Document not found</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-surface)]">
      {/* Toolbar */}
      <div
        className="titlebar-drag flex items-center justify-between px-3 border-b border-[var(--color-border)] shrink-0"
        style={{ height: 'var(--titlebar-height)' }}
      >
        <div className="titlebar-no-drag flex items-center gap-1 flex-1 min-w-0">
          {!sidebarOpen && (
            <Button variant="ghost" size="icon" onClick={toggleSidebar} className="shrink-0 mr-1">
              <PanelLeft size={14} />
            </Button>
          )}

          {/* Title */}
          <div className="flex-1 min-w-0 mr-2">
            {editingTitle ? (
              <input
                value={localTitle}
                onChange={(e) => setLocalTitle(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleSave()
                  if (e.key === 'Escape') { setLocalTitle(doc.title); setEditingTitle(false) }
                }}
                className="w-full text-sm font-semibold bg-transparent border-none outline-none text-[var(--color-text-primary)] focus:ring-0"
                autoFocus
              />
            ) : (
              <button
                onClick={() => setEditingTitle(true)}
                className="text-sm font-semibold text-[var(--color-text-primary)] hover:text-accent transition-colors truncate max-w-[280px] text-left block"
              >
                {doc.title}
              </button>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            {/* Formatting toolbar */}
            {viewMode !== 'preview' && (
              <div className="hidden md:flex items-center gap-0.5 mr-1.5 pr-1.5 border-r border-[var(--color-border)]">
                {[
                  { icon: <Hash size={12} />, before: '# ', after: '', tip: 'H1' },
                  { icon: <Bold size={12} />, before: '**', after: '**', tip: 'Bold' },
                  { icon: <Italic size={12} />, before: '_', after: '_', tip: 'Italic' },
                  { icon: <Code size={12} />, before: '`', after: '`', tip: 'Code' },
                  { icon: <Link size={12} />, before: '[', after: '](url)', tip: 'Link' },
                  { icon: <List size={12} />, before: '- ', after: '', tip: 'List' },
                  { icon: <CheckSquare size={12} />, before: '- [ ] ', after: '', tip: 'Task' }
                ].map(({ icon, before, after, tip }) => (
                  <Tooltip key={tip}>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" onClick={() => insertMarkdown(before, after)}>
                        {icon}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{tip}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => starMut.mutate(doc.id)}>
                  <Star size={13} className={doc.isStarred ? 'text-amber-500 fill-amber-500' : ''} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{doc.isStarred ? 'Unstar' : 'Star'}</TooltipContent>
            </Tooltip>

            {/* View mode */}
            <div className="flex items-center rounded border border-[var(--color-border)] overflow-hidden ml-1">
              {([
                { mode: 'edit' as ViewMode, icon: <Edit3 size={12} />, tip: 'Editor' },
                { mode: 'split' as ViewMode, icon: <Columns size={12} />, tip: 'Split' },
                { mode: 'preview' as ViewMode, icon: <Eye size={12} />, tip: 'Preview' }
              ] as const).map(({ mode, icon, tip }) => (
                <Tooltip key={mode}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setViewMode(mode)}
                      className={cn(
                        'px-2 py-1 text-xs transition-colors',
                        viewMode === mode
                          ? 'bg-[var(--color-accent-muted)] text-accent'
                          : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                      )}
                    >
                      {icon}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{tip}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 px-4 py-0.5 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <span className="text-2xs text-[var(--color-text-tertiary)]">{doc.wordCount} words</span>
        {updateMut.isPending && (
          <span className="text-2xs text-[var(--color-text-tertiary)]">Saving…</span>
        )}
        {!updateMut.isPending && updateMut.isSuccess && (
          <span className="text-2xs text-[var(--color-success)]">✓ Saved</span>
        )}
      </div>

      {/* Editor / Preview / Split */}
      <div ref={splitContainerRef} className="flex-1 flex min-h-0 overflow-hidden">
        {viewMode === 'edit' && (
          <MarkdownEditor content={localContent} onChange={handleContentChange} />
        )}
        {viewMode === 'preview' && (
          <MarkdownPreview content={localContent} />
        )}
        {viewMode === 'split' && (
          <>
            <div className="min-w-0 overflow-hidden" style={{ width: `${splitRatio * 100}%` }}>
              <MarkdownEditor content={localContent} onChange={handleContentChange} />
            </div>
            {/* Draggable divider */}
            <div
              onMouseDown={startSplitDrag}
              className="relative w-px shrink-0 bg-[var(--color-border)] cursor-col-resize group/divider z-10"
            >
              <div className="absolute inset-y-0 -left-1 -right-1 hover:bg-accent/20 transition-colors" />
              <GripVertical
                size={12}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] opacity-0 group-hover/divider:opacity-100 transition-opacity pointer-events-none"
              />
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
              <MarkdownPreview content={localContent} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Minimal toolbar for empty state
function Toolbar({
  sidebarOpen,
  onToggleSidebar,
  viewMode,
  setViewMode
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  viewMode: ViewMode
  setViewMode: (m: ViewMode) => void
}) {
  return (
    <div
      className="titlebar-drag flex items-center px-3 border-b border-[var(--color-border)] shrink-0"
      style={{ height: 'var(--titlebar-height)' }}
    >
      <div className="titlebar-no-drag flex items-center gap-2">
        {!sidebarOpen && (
          <Button variant="ghost" size="icon" onClick={onToggleSidebar}>
            <PanelLeft size={14} />
          </Button>
        )}
      </div>
    </div>
  )
}
