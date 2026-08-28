import React, { useEffect, useRef, useCallback, useState } from 'react'
import {
  Edit3,
  Eye,
  Columns,
  Hash,
  Bold,
  Italic,
  Code,
  Link,
  List,
  CheckSquare,
  GripVertical,
  PenLine,
  Lock,
  PanelLeft,
  X,
  FolderOpen,
  Save,
  SaveAll,
  RotateCcw,
  Info,
  FileOutput,
  Copy,
} from 'lucide-react'
import { cn, baseName } from '../../lib/utils'
import { useUIStore } from '../../store/ui'
import {
  useDocument,
  useUpdateDocument,
  useOpenPaths,
  useOpenFolder,
  useSaveDocumentAs,
  useReloadDocument,
} from '../../hooks/useDocuments'
import { MarkdownEditor } from './MarkdownEditor'
import { MarkdownPreview } from '../preview/MarkdownPreview'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { useLocalDocument } from '../../hooks/useLocalDocument'
import type { ViewMode } from '../../types'
import { useT } from '../../i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

export function EditorPane(): React.ReactElement {
  const {
    activeDocumentId,
    viewMode,
    setViewMode,
    editable,
    toggleEditable,
    toggleSidebar,
    closeDocument,
    externalChange,
    clearExternalChange,
  } = useUIStore()
  const { t } = useT()
  const { data: doc, isLoading } = useDocument(activeDocumentId)
  const updateMut = useUpdateDocument()
  const saveAsMut = useSaveDocumentAs()
  const reloadMut = useReloadDocument()
  const openPathsMut = useOpenPaths()
  const openFolderMut = useOpenFolder()

  const {
    localContent,
    localTitle,
    setLocalTitle,
    editingTitle,
    setEditingTitle,
    handleContentChange,
    handleTitleSave,
    dirty,
    markSaved,
    toDiskFormat,
    getEol,
  } = useLocalDocument(doc, activeDocumentId)

  // Save / Save As / Reload: hold the latest draft in a ref so callbacks don't capture a stale closure.
  // Initialized once; the effect keeps the fields in sync (mutating fields avoids reassigning the ref).
  const draftRef = useRef({ localContent, localTitle })
  useEffect(() => {
    draftRef.current.localContent = localContent
    draftRef.current.localTitle = localTitle
  })

  const handleSaveAs = useCallback(async () => {
    const id = useUIStore.getState().activeDocumentId
    if (!id) return
    // In read-only mode, block Save As and prompt the user to switch to edit mode
    if (!useUIStore.getState().editable) return
    const { localContent, localTitle } = draftRef.current
    const defaultPath = doc?.filePath || `${localTitle.trim() || 'Untitled'}.md`
    // Save As: follow the source document's on-disk line ending (the new file is a copy of this document)
    const eol = doc?.filePath
      ? await window.api.documents.eol(doc.filePath).catch(() => getEol())
      : getEol()
    let newFilePath: string | null
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
        updates: {
          title: localTitle.trim() || 'Untitled',
          content: toDiskFormat(localContent, eol),
        },
      })
      if (updated) {
        markSaved(updated.content, updated.title)
        useUIStore.getState().setJustSaved(true)
        useUIStore.getState().setIsNewUnsaved(false) // document now lives at the chosen path
      }
    } catch (e) {
      console.error('Save As failed', e)
      window.alert(t('app.saveFailed'))
    } finally {
      useUIStore.getState().setSaving(false)
    }
  }, [doc, saveAsMut, markSaved, getEol, toDiskFormat, t])

  const handleSave = useCallback(async () => {
    const id = useUIStore.getState().activeDocumentId
    if (!id) return
    // In read-only mode, block saving and prompt the user to switch to edit mode
    if (!useUIStore.getState().editable) return
    // A brand-new in-app document hasn't been placed at a user-chosen path yet: the first Save
    // must prompt for a path (Save As) instead of silently overwriting the default-location file.
    if (useUIStore.getState().isNewUnsaved) {
      await handleSaveAs()
      return
    }
    const { localContent, localTitle } = draftRef.current
    // Re-read the on-disk line ending at save time as the final source of truth (don't depend on
    // whether the async effect finished or the store is clean)
    const eol = doc?.filePath
      ? await window.api.documents.eol(doc.filePath).catch(() => getEol())
      : getEol()
    useUIStore.getState().setSaving(true)
    try {
      const updated = await updateMut.mutateAsync({
        id,
        updates: {
          title: localTitle.trim() || 'Untitled',
          content: toDiskFormat(localContent, eol),
        },
      })
      if (updated) {
        markSaved(updated.content, updated.title)
        useUIStore.getState().setJustSaved(true)
      }
    } catch (e) {
      console.error('Save failed', e)
      window.alert(t('app.saveFailed'))
    } finally {
      useUIStore.getState().setSaving(false)
    }
  }, [updateMut, handleSaveAs, markSaved, doc, getEol, toDiskFormat, t])

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
        window.alert(t('app.fileGone'))
        useUIStore.getState().clearExternalChange()
      }
    } catch (e) {
      console.error('Reload failed', e)
    } finally {
      useUIStore.getState().setSaving(false)
    }
  }, [reloadMut, markSaved, t])

  // Close button: confirm first if there are unsaved changes
  const handleClose = useCallback(async () => {
    if (useUIStore.getState().dirty) {
      const ok = await window.api.dialog.confirm({
        message: t('app.unsavedClose'),
        okText: t('app.confirmDiscard'),
        cancelText: t('app.confirmKeep'),
      })
      if (!ok) return
    }
    closeDocument()
  }, [closeDocument, t])

  // Menu (Save / Save As / Reload): register the listeners with the current handler closures.
  // Re-register whenever a handler identity changes (they depend on doc / mutation fns), which
  // keeps the menu actions in sync without holding the latest implementation in a mutable ref.
  useEffect(() => {
    const rmSave = window.api.onMenuEvent('save', () => void handleSave())
    const rmSaveAs = window.api.onMenuEvent('save-as', () => void handleSaveAs())
    const rmReload = window.api.onMenuEvent('reload', () => void handleReload())
    return () => {
      rmSave()
      rmSaveAs()
      rmReload()
    }
  }, [handleSave, handleSaveAs, handleReload])

  // Receive the "file changed on disk" event sent from the main process.
  // The watcher itself lives entirely in the main process (chokidar over the
  // opened folders), so the renderer no longer has to attach/detach per document.
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

  // Clicking a folder segment in the breadcrumb navigates the sidebar to that directory.
  // `segments` is the path split on `/` with empty parts removed, so for POSIX paths the
  // leading root `/` is also removed and must be prepended back. For Windows drive paths,
  // the drive letter (e.g. `D:`) is kept as the first segment; clicking it should resolve
  // to `D:/`, so we restore the trailing slash in that case.
  // NOTE: UNC paths (//server/share/...) are NOT supported — they start with `/` and are
  // treated as POSIX absolute paths here (and by the store's `isInFolder`), so the leading
  // `//` is dropped and navigation would be wrong. This mirrors the rest of the codebase,
  // which also does not handle UNC paths.
  const handleNavigateToSegment = useCallback(
    (segments: string[], index: number) => {
      // `doc` is guaranteed non-null here: the breadcrumb (and this handler's
      // click target at line ~687) only render when `doc.filePath` exists, and
      // the render body already accesses `doc.filePath` unguarded. A defensive
      // `if (!doc?.filePath) return` would be an unreachable branch.
      const norm = doc!.filePath.replace(/\\/g, '/')
      const isPosixAbs = norm.startsWith('/')
      const isWinAbs = /^[a-zA-Z]:\//.test(norm)
      const prefix = isPosixAbs ? '/' : ''
      let dirPath = prefix + segments.slice(0, index + 1).join('/')
      if (isWinAbs && index === 0) {
        dirPath += '/'
      }
      useUIStore.getState().setActiveFolder(dirPath)
    },
    [doc],
  )

  // Copy the full path or just the file name from the breadcrumb.
  const handleCopyPath = useCallback(
    async (mode: 'full' | 'name') => {
      if (!doc?.filePath) return
      const text = mode === 'full' ? doc.filePath : baseName(doc.filePath)
      try {
        await window.api.clipboard.writeText(text)
      } catch {
        // ignore copy failures
      }
    },
    [doc],
  )

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

  // Shared toolbar: open/close/sidebar/edit-mode toggle (used by both empty and document states)
  const CommonToolbar = (
    <div className="titlebar-no-drag flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('menu.toggleSidebar')}
            data-testid="sidebar-toggle-btn"
            onClick={toggleSidebar}
          >
            <PanelLeft size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('editor.toggleSidebarShortcut')}</TooltipContent>
      </Tooltip>
      {/* Save / Save As / Reload — grouped with Open/Close as file operations, kept on the left */}
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
                data-testid="save-btn"
              >
                <Save size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editable
                ? dirty
                  ? t('editor.saveShortcut')
                  : t('editor.noChanges')
                : t('editor.saveSwitchEdit')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSaveAs}
                disabled={!editable || saveAsMut.isPending}
                data-testid="save-as-btn"
              >
                <SaveAll size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {editable ? t('editor.saveAsShortcut') : t('editor.saveAsSwitchEdit')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleReload}
                disabled={reloadMut.isPending}
                data-testid="reload-btn"
              >
                <RotateCcw size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('editor.reloadShortcut')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => doc && useUIStore.getState().setFileDetailsId(doc.id)}
                data-testid="file-details-btn"
              >
                <Info size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('editor.fileDetailsShortcut')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => useUIStore.getState().setExportOpen(true)}
                data-testid="export-btn"
              >
                <FileOutput size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('editor.exportShortcut')}</TooltipContent>
          </Tooltip>

          <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={handleClose} data-testid="close-btn">
            <X size={13} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('editor.closeFile')}</TooltipContent>
      </Tooltip>

      <div className="w-px h-4 bg-[var(--color-border)] mx-1" />

      {/* Read-only / edit mode toggle */}
      {editable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleEditable}
              className="gap-1"
              data-testid="toggle-editable-btn"
            >
              <Lock size={12} /> {t('editor.readOnly')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('editor.switchReadOnly')}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="accent"
              size="sm"
              onClick={toggleEditable}
              className="gap-1"
              data-testid="toggle-editable-btn"
            >
              <PenLine size={12} /> {t('editor.edit')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('editor.switchEdit')}</TooltipContent>
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
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)] mb-1">
              {t('editor.noDocument')}
            </h2>
            <p className="text-sm text-[var(--color-text-tertiary)] mb-4">
              {t('editor.openToGetStarted')}
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="accent" size="sm" onClick={handleOpenFile}>
                {t('sidebar.openFileAction')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleOpenFolder}>
                {t('sidebar.openFolderAction')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--color-surface)]">
        <div className="text-sm text-[var(--color-text-tertiary)]">{t('editor.loading')}</div>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--color-surface)]">
        <div className="text-sm text-[var(--color-text-tertiary)]">{t('editor.notFound')}</div>
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
                    if (e.key === 'Escape') {
                      setLocalTitle(doc.title)
                      setEditingTitle(false)
                    }
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
            {/* Formatting toolbar (only available in edit mode) */}
            {viewMode !== 'preview' && editable && (
              <div className="hidden md:flex items-center gap-0.5 mr-1.5 pr-1.5 border-r border-[var(--color-border)]">
                {[
                  { icon: <Hash size={12} />, before: '# ', after: '', tip: t('editor.fmt.h1') },
                  {
                    icon: <Bold size={12} />,
                    before: '**',
                    after: '**',
                    tip: t('editor.fmt.bold'),
                  },
                  {
                    icon: <Italic size={12} />,
                    before: '_',
                    after: '_',
                    tip: t('editor.fmt.italic'),
                  },
                  { icon: <Code size={12} />, before: '`', after: '`', tip: t('editor.fmt.code') },
                  {
                    icon: <Link size={12} />,
                    before: '[',
                    after: '](url)',
                    tip: t('editor.fmt.link'),
                  },
                  { icon: <List size={12} />, before: '- ', after: '', tip: t('editor.fmt.list') },
                  {
                    icon: <CheckSquare size={12} />,
                    before: '- [ ] ',
                    after: '',
                    tip: t('editor.fmt.task'),
                  },
                ].map(({ icon, before, after, tip }) => (
                  <Tooltip key={tip}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => insertMarkdown(before, after)}
                        data-testid={`fmt-${before}-${after}`}
                      >
                        {icon}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{tip}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}

            {/* View mode */}
            <div className="flex items-center rounded border border-[var(--color-border)] overflow-hidden ml-1">
              {(
                [
                  {
                    mode: 'edit' as ViewMode,
                    icon: <Edit3 size={12} />,
                    tip: t('editor.view.editor'),
                  },
                  {
                    mode: 'split' as ViewMode,
                    icon: <Columns size={12} />,
                    tip: t('editor.view.split'),
                  },
                  {
                    mode: 'preview' as ViewMode,
                    icon: <Eye size={12} />,
                    tip: t('editor.view.preview'),
                  },
                ] as const
              ).map(({ mode, icon, tip }) => (
                <Tooltip key={mode}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setViewMode(mode)}
                      data-testid={`view-${mode}`}
                      className={cn(
                        'px-2 py-1 text-xs transition-colors',
                        viewMode === mode
                          ? 'bg-[var(--color-accent-muted)] text-accent'
                          : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]',
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

      {/* File-path breadcrumb: shows the current path as "folder / file name" */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] shrink-0 text-xs overflow-hidden">
        <button
          onClick={() => doc.filePath && window.api.app.showInFolder(doc.filePath)}
          className="shrink-0 text-[var(--color-text-tertiary)] hover:text-accent transition-colors"
          title={t('editor.showInFolder')}
        >
          <FolderOpen size={12} />
        </button>
        <div
          className="flex items-center gap-0.5 min-w-0 overflow-hidden text-[var(--color-text-tertiary)]"
          title={doc.filePath}
        >
          {(() => {
            const segments = doc.filePath.replace(/\\/g, '/').split('/').filter(Boolean)
            return segments.map((seg: string, i: number, arr: string[]) => {
              const isLast = i === arr.length - 1
              return (
                <span key={i} className="flex items-center gap-0.5 min-w-0">
                  {isLast ? (
                    <span className="truncate text-[var(--color-text-primary)] font-medium">
                      {seg}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleNavigateToSegment(segments, i)}
                      className="truncate hover:text-accent transition-colors"
                      title={t('editor.openSegmentFolder')}
                    >
                      {seg}
                    </button>
                  )}
                  {!isLast && <span className="text-[var(--color-border-strong)] shrink-0">/</span>}
                </span>
              )
            })
          })()}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="shrink-0 ml-1 text-[var(--color-text-tertiary)] hover:text-accent transition-colors"
              title={t('editor.copyPath')}
            >
              <Copy size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleCopyPath('full')}>
              {t('editor.copyFullPath')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyPath('name')}>
              {t('editor.copyFileName')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Editor / Preview / Split */}
      <div ref={splitContainerRef} className="flex-1 flex min-h-0 overflow-hidden">
        {/* Editor: shown in edit / split; hidden in preview mode */}
        {viewMode !== 'preview' && (
          <div
            className={
              viewMode === 'split' ? 'min-w-0 overflow-hidden' : 'flex-1 min-w-0 overflow-hidden'
            }
            style={viewMode === 'split' ? { width: `${splitRatio * 100}%` } : undefined}
          >
            <MarkdownEditor
              content={localContent}
              onChange={handleContentChange}
              editable={editable}
              docId={activeDocumentId}
            />
          </div>
        )}

        {/* Draggable divider (split mode only) */}
        {viewMode === 'split' && (
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
        )}

        {/* Preview: shown in preview / split; hidden in edit mode but still mounted so the single
            export-HTML data source stays ready (R7) */}
        <div className={viewMode === 'edit' ? 'hidden' : 'flex-1 min-w-0 overflow-hidden'}>
          <MarkdownPreview content={localContent} />
        </div>
      </div>

      {/* Prompt shown when the on-disk file was changed by another program */}
      {externalChange && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) clearExternalChange()
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('editor.diskChangedTitle')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-[var(--color-text-secondary)] mb-5">
              {dirty ? t('editor.diskChangedDirty') : t('editor.diskChangedClean')}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => clearExternalChange()}
                data-testid="external-ignore-btn"
              >
                {t('editor.ignore')}
              </Button>
              <Button
                variant="accent"
                size="sm"
                onClick={() => {
                  clearExternalChange()
                  handleReload()
                }}
                data-testid="external-reload-btn"
              >
                {t('editor.reloadBtn')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
