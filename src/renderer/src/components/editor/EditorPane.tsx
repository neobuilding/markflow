import React, { useEffect, useRef, useCallback, useState } from 'react'
import {
  Edit3, Eye, Columns, Hash, Bold, Italic, Code, Link, List, CheckSquare, PanelLeft,
  GripVertical, PenLine, Lock, X, FolderOpen, Folder, Save, SaveAll, RotateCcw, Info
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../store/ui'
import {
  useDocument, useUpdateDocument, useOpenPaths, useOpenFolder,
  useSaveDocumentAs, useReloadDocument
} from '../../hooks/useDocuments'
import { MarkdownEditor } from './MarkdownEditor'
import { MarkdownPreview } from '../preview/MarkdownPreview'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { useLocalDocument } from '../../hooks/useLocalDocument'
import type { ViewMode } from '../../types'

export function EditorPane(): React.ReactElement {
  const {
    activeDocumentId, viewMode, setViewMode, sidebarOpen, toggleSidebar, editable,
    toggleEditable, closeDocument, externalChange, clearExternalChange
  } = useUIStore()
  const { data: doc, isLoading } = useDocument(activeDocumentId)
  const updateMut = useUpdateDocument()
  const saveAsMut = useSaveDocumentAs()
  const reloadMut = useReloadDocument()
  const openPathsMut = useOpenPaths()
  const openFolderMut = useOpenFolder()

  const {
    localContent, setLocalContent, localTitle, setLocalTitle,
    editingTitle, setEditingTitle, handleContentChange, handleTitleSave, dirty, markSaved, toDiskFormat, getEol
  } = useLocalDocument(doc, activeDocumentId)

  // 保存/另存为/重新加载：用 ref 持有最新草稿，避免菜单/快捷键回调拿到旧闭包
  const draftRef = useRef({ localContent, localTitle })
  draftRef.current = { localContent, localTitle }

  const handleSave = useCallback(async () => {
    const id = useUIStore.getState().activeDocumentId
    if (!id) return
    // 只读模式下禁止保存，提示用户切换到编辑模式
    if (!useUIStore.getState().editable) return
    const { localContent, localTitle } = draftRef.current
    // 保存瞬间再读一次磁盘换行符，作为最终权威来源（不依赖异步 effect 是否完成、DB 是否干净）
    const eol = doc?.filePath
      ? await window.api.documents.eol(doc.filePath).catch(() => getEol())
      : getEol()
    useUIStore.getState().setSaving(true)
    try {
      const updated = await updateMut.mutateAsync({
        id,
        updates: { title: localTitle.trim() || 'Untitled', content: toDiskFormat(localContent, eol) }
      })
      if (updated) {
        markSaved(updated.content, updated.title)
        useUIStore.getState().setJustSaved(true)
        // 重新监听（文件名可能因标题变更而改名）
        window.api.documents.unwatch(id)
        window.api.documents.watch(id)
      }
    } catch (e) {
      console.error('Save failed', e)
      window.alert('Failed to save the file.')
    } finally {
      useUIStore.getState().setSaving(false)
    }
  }, [updateMut, markSaved, doc?.filePath, getEol])

  const handleSaveAs = useCallback(async () => {
    const id = useUIStore.getState().activeDocumentId
    if (!id) return
    // 只读模式下禁止另存为，提示用户切换到编辑模式
    if (!useUIStore.getState().editable) return
    const { localContent, localTitle } = draftRef.current
    const defaultPath = doc?.filePath || `${localTitle.trim() || 'Untitled'}.md`
    // 另存为：以源文档磁盘换行符为风格（新文件是本文档内容的副本）
    const eol = doc?.filePath
      ? await window.api.documents.eol(doc.filePath).catch(() => getEol())
      : getEol()
    let newFilePath: string | null = null
    try {
      newFilePath = await window.api.dialog.saveFile(defaultPath)
    } catch {
      return
    }
    if (!newFilePath) return
    useUIStore.getState().setSaving(true)
    try {
      const updated = await saveAsMut.mutateAsync({
        id,
        filePath: newFilePath,
        updates: { title: localTitle.trim() || 'Untitled', content: toDiskFormat(localContent, eol) }
      })
      if (updated) {
        markSaved(updated.content, updated.title)
        useUIStore.getState().setJustSaved(true)
        window.api.documents.unwatch(id)
        window.api.documents.watch(id)
      }
    } catch (e) {
      console.error('Save As failed', e)
      window.alert('Failed to save the file.')
    } finally {
      useUIStore.getState().setSaving(false)
    }
  }, [doc?.filePath, saveAsMut, markSaved])

  const handleReload = useCallback(async () => {
    const id = useUIStore.getState().activeDocumentId
    if (!id) return
    useUIStore.getState().setSaving(true)
    try {
      const updated = await reloadMut.mutateAsync(id)
      if (updated) {
        markSaved(updated.content, updated.title)
        useUIStore.getState().setJustSaved(true)
        useUIStore.getState().clearExternalChange()
      } else {
        window.alert('The file no longer exists on disk.')
        useUIStore.getState().clearExternalChange()
      }
    } catch (e) {
      console.error('Reload failed', e)
    } finally {
      useUIStore.getState().setSaving(false)
    }
  }, [reloadMut, markSaved])

  // 关闭按钮：若有未保存改动先确认
  const handleClose = useCallback(() => {
    if (useUIStore.getState().dirty && !window.confirm('You have unsaved changes. Discard them?')) return
    closeDocument()
  }, [closeDocument])

  // 菜单（Save / Save As / Reload）与文件监听：仅注册一次，通过 ref 取最新实现
  const handlersRef = useRef({ handleSave, handleSaveAs, handleReload })
  handlersRef.current = { handleSave, handleSaveAs, handleReload }

  useEffect(() => {
    const rmSave = window.api.onMenuEvent('save', () => handlersRef.current.handleSave())
    const rmSaveAs = window.api.onMenuEvent('save-as', () => handlersRef.current.handleSaveAs())
    const rmReload = window.api.onMenuEvent('reload', () => handlersRef.current.handleReload())
    return () => { rmSave(); rmSaveAs(); rmReload() }
  }, [])

  // 监听当前文档对应文件的磁盘改动
  useEffect(() => {
    if (!activeDocumentId) return
    window.api.documents.watch(activeDocumentId).catch(() => {})
    return () => { window.api.documents.unwatch(activeDocumentId).catch(() => {}) }
  }, [activeDocumentId])

  // 接收主进程发来的“文件已在磁盘被改动”事件
  useEffect(() => {
    const rm = window.api.onFileChanged((data: { id: string; filePath: string }) => {
      if (data.id === useUIStore.getState().activeDocumentId) {
        useUIStore.getState().setExternalChange(data)
      }
    })
    return rm
  }, [])

  const handleOpenFile = useCallback(async () => {
    const filePaths = await window.api.dialog.openFiles()
    if (filePaths.length) openPathsMut.mutate(filePaths)
  }, [openPathsMut])

  const handleOpenFolder = useCallback(async () => {
    const folderPath = await window.api.dialog.openFolderPath()
    if (folderPath) openFolderMut.mutate(folderPath)
  }, [openFolderMut])

  // Split view: draggable divider. splitRatio is the editor's width fraction (0–1).
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [splitRatio, setSplitRatio] = useState(0.5)
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

  const insertMarkdown = useCallback((before: string, after: string = '') => {
    document.dispatchEvent(new CustomEvent('markdown:insert', { detail: { before, after } }))
  }, [])

  // 通用工具栏：打开/关闭/侧栏/编辑模式切换（空状态与文档状态共用）
  const CommonToolbar = (
    <div className="titlebar-no-drag flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={handleOpenFile} disabled={openPathsMut.isPending}>
            <FolderOpen size={13} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open File... (⌘O)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={handleOpenFolder} disabled={openFolderMut.isPending}>
            <Folder size={13} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open Folder... (⌘⇧O)</TooltipContent>
      </Tooltip>

      <div className="w-px h-4 bg-[var(--color-border)] mx-1" />

      {/* Save / Save As / Reload —— 与 Open/Close 同属文件操作，统一放在左侧 */}
      {activeDocumentId && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSave}
                disabled={!editable || !dirty || updateMut.isPending || saveAsMut.isPending}
                className={editable && dirty ? 'text-accent' : ''}
              >
                <Save size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editable ? (dirty ? 'Save (⌘S)' : 'No changes to save') : 'Save — switch to Edit mode first'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSaveAs}
                disabled={!editable || saveAsMut.isPending}
              >
                <SaveAll size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editable ? 'Save As… (⌘⇧S)' : 'Save As… — switch to Edit mode first'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleReload} disabled={reloadMut.isPending}>
                <RotateCcw size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload from Disk (⌘⇧R)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => doc && useUIStore.getState().setFileDetailsId(doc.id)}
              >
                <Info size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>File details (⌘I)</TooltipContent>
          </Tooltip>

          <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <X size={13} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Close file</TooltipContent>
      </Tooltip>

      <div className="w-px h-4 bg-[var(--color-border)] mx-1" />

      {!sidebarOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={toggleSidebar}>
              <PanelLeft size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Sidebar (⌘\)</TooltipContent>
        </Tooltip>
      )}

      {/* 只读 / 编辑模式切换 */}
      {editable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={toggleEditable} className="gap-1">
              <Lock size={12} /> Read-only
            </Button>
          </TooltipTrigger>
          <TooltipContent>Switch to read-only mode</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="accent" size="sm" onClick={toggleEditable} className="gap-1">
              <PenLine size={12} /> Edit
            </Button>
          </TooltipTrigger>
          <TooltipContent>Switch to edit mode</TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  if (!activeDocumentId) {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-surface)]">
        <div
          className="titlebar-drag flex items-center justify-between px-3 border-b border-[var(--color-border)] shrink-0"
          style={{ height: 'var(--titlebar-height)' }}
        >
          {CommonToolbar}
          <div className="flex-1" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-[var(--color-accent-muted)] flex items-center justify-center mx-auto mb-4">
              <Edit3 size={28} className="text-accent" />
            </div>
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">No document selected</h2>
            <p className="text-sm text-[var(--color-text-tertiary)] mb-4">Open a file or folder to get started</p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="accent" size="sm" onClick={handleOpenFile}>Open File…</Button>
              <Button variant="outline" size="sm" onClick={handleOpenFolder}>Open Folder…</Button>
            </div>
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
          {CommonToolbar}

          <div className="w-px h-4 bg-[var(--color-border)] mx-1" />

          {/* Title */}
          <div className="flex-1 min-w-0 mr-2">
            {editable ? (
              editingTitle ? (
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
              )
            ) : (
              <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate max-w-[280px] block">
                {doc.title}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            {/* Formatting toolbar (仅编辑模式可用) */}
            {viewMode !== 'preview' && editable && (
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

            {/* Save / Save As / Reload 已移至左侧文件操作区（见 CommonToolbar） */}

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

      {/* 文件路径 breadcrumb：以「文件夹 / 文件名」形式展示当前文件路径 */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] shrink-0 text-xs overflow-hidden">
        <button
          onClick={() => doc.filePath && window.api.app.showInFolder(doc.filePath)}
          className="shrink-0 text-[var(--color-text-tertiary)] hover:text-accent transition-colors"
          title="Show in folder"
        >
          <FolderOpen size={12} />
        </button>
        <div
          className="flex items-center gap-0.5 min-w-0 overflow-hidden text-[var(--color-text-tertiary)]"
          title={doc.filePath}
        >
          {doc.filePath.replace(/\\/g, '/').split('/').filter(Boolean).map((seg: string, i: number, arr: string[]) => {
            const isLast = i === arr.length - 1
            return (
              <span key={i} className="flex items-center gap-0.5 min-w-0">
                <span
                  className={cn(
                    'truncate',
                    isLast ? 'text-[var(--color-text-primary)] font-medium' : 'hover:text-[var(--color-text-secondary)]'
                  )}
                >
                  {seg}
                </span>
                {!isLast && <span className="text-[var(--color-border-strong)] shrink-0">/</span>}
              </span>
            )
          })}
        </div>
      </div>

      {/* Editor / Preview / Split */}
      <div ref={splitContainerRef} className="flex-1 flex min-h-0 overflow-hidden">
        {viewMode === 'edit' && (
          <MarkdownEditor content={localContent} onChange={handleContentChange} editable={editable} docId={activeDocumentId} />
        )}
        {viewMode === 'preview' && (
          <MarkdownPreview content={localContent} />
        )}
        {viewMode === 'split' && (
          <>
            <div className="min-w-0 overflow-hidden" style={{ width: `${splitRatio * 100}%` }}>
              <MarkdownEditor content={localContent} onChange={handleContentChange} editable={editable} docId={activeDocumentId} />
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

      {/* 磁盘文件被其它程序改动的提示 */}
      {externalChange && (
        <Dialog open onOpenChange={(o) => { if (!o) clearExternalChange() }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>File changed on disk</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-[var(--color-text-secondary)] mb-5">
              {dirty
                ? 'This file was modified by another program. Reloading will discard your unsaved changes.'
                : 'This file was modified by another program. Reload to load the latest version from disk?'}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => clearExternalChange()}>
                Ignore
              </Button>
              <Button
                variant="accent"
                size="sm"
                onClick={() => {
                  clearExternalChange()
                  handleReload()
                }}
              >
                Reload
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
