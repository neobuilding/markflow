import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FileText,
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  FolderOpen,
  Folder,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ArrowUp,
  ArrowRight,
  X,
  GripVertical,
  PenLine,
  Copy,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  cn,
  formatDate,
  isInFolder,
  isDirInFolder,
  buildFileTree,
  isMac,
  formatShortcut,
  baseName,
  dirName,
  joinPath,
  repointExpandedSet,
  type FileTreeNode,
} from '../../lib/utils'
import { splitMemoryOnlyDocs, memoryOnlyLeaf } from '../../lib/sidebarDrafts'
import { useT } from '../../i18n'
import { useUIStore } from '../../store/ui'
import { DOCS_KEY } from '../../lib/queryClient'
import {
  useDocuments,
  useDeleteDocument,
  useCreateDocument,
  useOpenPaths,
  useOpenFolder,
  useCreateFolder,
  useRenameFolder,
  useDeleteFolder,
  useFolderDirs,
} from '../../hooks/useDocuments'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../ui/context-menu'
import type { Document } from '../../types'

// Inline folder naming : 'create' adds a subfolder under `parentPath`,
// 'rename' renames `targetPath`. Null means no row is being named.
type FolderEdit = { mode: 'create'; parentPath: string } | { mode: 'rename'; targetPath: string }

export function Sidebar(): React.ReactElement | null {
  const {
    sidebarOpen,
    toggleSidebar,
    activeDocumentId,
    setActiveDocumentId,
    setSearchOpen,
    activeFolder,
    setActiveFolder,
    closeWorkspace,
  } = useUIStore()
  const { t } = useT()
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const isResizing = useRef(false)
  // The aside is sized from React state; mirror it into the CSS variable so the drag and
  // the width reset stay consistent (the variable used to be written by the drag handler
  // only, so resetting left it stale).
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`)
  }, [sidebarWidth])
  // Exporting (or with the export dialog open) hard-locks every "close" action, so the
  // current-folder bar's "Close Workspace" item must grey out too
  const workspaceLocked = useUIStore((s) => s.exporting || s.exportOpen)

  // ── Folder expand state ──
  // Lifted out of `TreeRow` (which used to own one `useState` per node) so an ancestor can
  // expand a whole subtree "Expand All" has no implementation path otherwise
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])
  // Recursively open every folder below `node` (including it). Only folders are added;
  // files are leaves with nothing to open.
  const expandAll = useCallback((node: FileTreeNode) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      const walk = (n: FileTreeNode) => {
        if (!n.isFolder) return
        next.add(n.path)
        n.children.forEach(walk)
      }
      walk(node)
      return next
    })
  }, [])

  const { data: allDocs = [], isLoading: loading } = useDocuments(activeFolder ?? undefined)

  // Split memory-only drafts (filePath === '') from folder documents. Drafts are shown in a
  // dedicated "Unsaved drafts" group above the tree, never via isInFolder (which is always false
  // for empty paths). (G2)
  const memoryOnlyDocs = useMemo(() => splitMemoryOnlyDocs(allDocs).memoryOnly, [allDocs])

  // Only show documents within the "current folder" (empty when no folder is open, the welcome
  // page takes over). Memoized so it's a stable dependency for the tree useMemo below.
  const folderDocs = useMemo(
    () => (activeFolder ? allDocs.filter((d) => isInFolder(d.filePath, activeFolder)) : []),
    [activeFolder, allDocs],
  )

  // Directories that exist on disk below the active folder. A tree built from documents
  // alone cannot show a folder that holds no Markdown file, so the folder list is the
  // source of truth for the folder nodes and documents hang off them.
  const { data: folderDirs = [] } = useFolderDirs(activeFolder)

  // Build the current folder's documents into a nested "folder + file" tree, supporting subfolders
  const tree = useMemo(
    () => (activeFolder ? buildFileTree(folderDocs, activeFolder, folderDirs) : []),
    [folderDocs, activeFolder, folderDirs],
  )

  // All deletable docs for "switch to next after delete" logic, including drafts. (G2)
  const allListedDocs = useMemo(
    () => [...memoryOnlyDocs, ...folderDocs],
    [memoryOnlyDocs, folderDocs],
  )

  const deleteMut = useDeleteDocument()
  const createMut = useCreateDocument()
  const openPathsMut = useOpenPaths()
  const openFolderMut = useOpenFolder()

  const handleImportFile = useCallback(async () => {
    const filePaths = await window.api.dialog.openFiles()
    if (filePaths.length === 0) return
    openPathsMut.mutate(filePaths)
  }, [openPathsMut])

  const handleImportFolder = useCallback(async () => {
    const folderPath = await window.api.dialog.openFolderPath()
    if (!folderPath) return
    openFolderMut.mutate(folderPath)
  }, [openFolderMut])

  const handleCreate = useCallback(async () => {
    const doc = await createMut.mutateAsync({ title: 'Untitled' })
    setActiveDocumentId(doc.id)
    useUIStore.getState().setEditable(true) // new documents are editable by default
    useUIStore.getState().setIsNewUnsaved(true) // first Save will prompt for a path
  }, [createMut, setActiveDocumentId])

  // Document select / delete / star / details: reused by the doc tree (including subfolders).
  // Returns whether the switch actually happened (false if the user cancelled the dirty
  // confirm) so callers like the "Rename" menu item can abort
  const handleSelectDoc = useCallback(
    async (doc: Document): Promise<boolean> => {
      if (useUIStore.getState().dirty) {
        const ok = await window.api.dialog.confirm({
          message: t('app.unsavedSwitch'),
          okText: t('app.confirmDiscard'),
          cancelText: t('app.confirmKeep'),
        })
        if (!ok) return false
      }
      setActiveDocumentId(doc.id)
      return true
    },
    [setActiveDocumentId, t],
  )

  // deletion is a destructive action and must be gated behind the in-app
  // confirm dialog before it runs. A memory-only draft has no file on disk, so it is a
  // "discard" (never touches the disk) and uses a different confirm message/button.
  const handleDeleteDoc = useCallback(
    async (doc: Document) => {
      const isDraft = !doc.filePath
      const ok = await window.api.dialog.confirm({
        message: t(isDraft ? 'app.discardDraftConfirm' : 'app.deleteConfirm'),
        okText: t(isDraft ? 'app.confirmDiscard' : 'app.deleteConfirmOk'),
        cancelText: t('app.cancel'),
      })
      if (!ok) return
      deleteMut.mutate(doc.id)
      if (activeDocumentId === doc.id) {
        const next = allListedDocs.find((d) => d.id !== doc.id)
        setActiveDocumentId(next?.id ?? null)
      }
    },
    [deleteMut, activeDocumentId, allListedDocs, setActiveDocumentId, t],
  )

  const handleDetailsDoc = useCallback((doc: Document) => {
    useUIStore.getState().setFileDetailsId(doc.id)
  }, [])

  // Close the workspace, asking first when there are unsaved changes. Shared by the
  // toolbar X button and the current-folder bar's context menu
  const confirmCloseWorkspace = useCallback(async () => {
    if (useUIStore.getState().dirty) {
      const ok = await window.api.dialog.confirm({
        message: t('app.unsavedCloseWorkspace'),
        okText: t('app.confirmDiscard'),
        cancelText: t('app.confirmKeep'),
      })
      if (!ok) return
    }
    closeWorkspace()
  }, [closeWorkspace, t])

  const copyText = useCallback((text: string) => {
    void window.api.clipboard.writeText(text)
  }, [])
  const revealInFolder = useCallback((target: string) => {
    // Failures (e.g. a file deleted outside the app) are swallowed so nothing surfaces
    // as an unhandled rejection same contract as the doc-item menu
    void Promise.resolve(window.api.app.showInFolder(target)).catch(() => {})
  }, [])
  // "New Document in This Folder": a real file is written straight into the folder so the
  // new document actually appears in that subtree (memory-only drafts have no filePath and
  // would land in the "Unsaved drafts" group instead).
  const createDocInFolder = useCallback(
    async (folder: string) => {
      const doc = await createMut.mutateAsync({
        title: 'Untitled',
        folderPath: folder,
        memoryOnly: false,
      })
      setActiveDocumentId(doc.id)
      useUIStore.getState().setEditable(true)
      useUIStore.getState().setIsNewUnsaved(false)
    },
    [createMut, setActiveDocumentId],
  )

  // Enter a subfolder: make it the active (current) folder.
  const handleEnterFolder = useCallback(
    (folder: string) => {
      setActiveFolder(folder)
    },
    [setActiveFolder],
  )

  // ── Inline folder create / rename / delete ──
  // VS Code-style: instead of opening a dialog, the menu flips the tree row into an
  // <input> (or inserts a temporary row for a new subfolder) and names it in place.
  const [folderEdit, setFolderEdit] = useState<FolderEdit | null>(null)
  const createFolderMut = useCreateFolder()
  const renameFolderMut = useRenameFolder()
  const deleteFolderMut = useDeleteFolder()

  const startFolderEdit = useCallback((edit: FolderEdit) => {
    setFolderEdit(edit)
    // A new subfolder does not exist yet, so its parent has to be expanded for the
    // temporary input row to be visible.
    if (edit.mode === 'create') {
      setExpanded((prev) => new Set(prev).add(edit.parentPath))
    }
  }, [])

  const cancelFolderEdit = useCallback(() => setFolderEdit(null), [])

  const submitFolderName = useCallback(
    async (name: string) => {
      /* v8 ignore next -- defensive: the inline input only renders while folderEdit is set */
      if (!folderEdit) return
      try {
        if (folderEdit.mode === 'create') {
          await createFolderMut.mutateAsync(joinPath(folderEdit.parentPath, name))
        } else {
          const newPath = joinPath(dirName(folderEdit.targetPath), name)
          await renameFolderMut.mutateAsync({ oldPath: folderEdit.targetPath, newPath })
          // The active folder may be the renamed one (or below it): re-point it, otherwise
          // the tree filter still looks under the old path and flips to the empty state.
          const active = useUIStore.getState().activeFolder
          if (active && isDirInFolder(active, folderEdit.targetPath)) {
            useUIStore
              .getState()
              .setActiveFolder(newPath + active.slice(folderEdit.targetPath.length))
          }
          // Re-point the expanded set so the renamed folder (and any expanded descendants)
          // keep the same open/closed state under the new path instead of collapsing.
          setExpanded((prev) => repointExpandedSet(prev, folderEdit.targetPath, newPath))
        }
        setFolderEdit(null)
      } catch (e) {
        // A name clash or a permission error rejects the mutation: keep the inline input
        // open so the user can pick another name instead of losing what they typed.
        console.error('Folder operation failed', e)
      }
    },
    [folderEdit, createFolderMut, renameFolderMut],
  )

  // Deleting a folder moves it to the OS trash ( semantics, ②), so the
  // confirmation says so and a rejected move never falls back to a permanent delete
  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const ok = await window.api.dialog.confirm({
        message: t('app.deleteFolderConfirm', { name: baseName(folderPath) }),
        okText: t('app.deleteConfirmOk'),
        cancelText: t('app.cancel'),
      })
      if (!ok) return
      try {
        await deleteFolderMut.mutateAsync(folderPath)
      } catch (e) {
        console.error('Delete folder failed', e)
      }
    },
    [deleteFolderMut, t],
  )
  // Sidebar resize drag handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = Math.max(180, Math.min(480, e.clientX))
      setSidebarWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (!isResizing.current) return
      isResizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [sidebarWidth])

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  // Parent folder of the current folder; null when at a root level (no parent to go up to).
  const parentFolder = useMemo(() => {
    if (!activeFolder) return null
    const parts = activeFolder.split(/[\\/]/).filter(Boolean)
    if (parts.length <= 1) return null
    const parent = activeFolder.slice(0, activeFolder.length - parts[parts.length - 1].length - 1)
    return parent
  }, [activeFolder])

  if (!sidebarOpen) return null

  const folderName = activeFolder
    ? (activeFolder.split(/[\\/]/).filter(Boolean).pop() ?? activeFolder)
    : ''

  return (
    <aside
      className="relative flex flex-col h-full border-r border-[var(--color-border)] bg-[var(--color-bg)] shrink-0 animate-slide-in-left"
      style={{ width: sidebarWidth }}
    >
      {/* Header (titlebar drag region) */}
      <div
        className="titlebar-drag flex items-center border-b border-[var(--color-border)] shrink-0 pr-2"
        style={{
          height: 'var(--titlebar-height)',
          paddingLeft: isMac() ? '5rem' : '0.75rem',
        }}
      >
        <div className="titlebar-no-drag flex items-center gap-1.5 flex-1 min-w-0">
          <div className="flex items-center gap-0.5 ml-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('sidebar.search')}
                  onClick={() => setSearchOpen(true)}
                >
                  <Search size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('sidebar.search')} ({formatShortcut('⌘K')})
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('sidebar.openFile')}
                  onClick={handleImportFile}
                  disabled={openPathsMut.isPending}
                >
                  <FolderOpen size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('sidebar.openFile')} ({formatShortcut('⌘O')})
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('sidebar.openFolder')}
                  data-testid="import-folder-btn"
                  onClick={handleImportFolder}
                  disabled={openFolderMut.isPending}
                >
                  <Folder size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('sidebar.openFolder')} ({formatShortcut('⌘⇧O')})
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('sidebar.newDocument')}
                  onClick={handleCreate}
                  disabled={createMut.isPending}
                  data-testid="new-document-btn"
                >
                  <Plus size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('sidebar.newDocument')} ({formatShortcut('⌘N')})
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Current folder bar right-click menu . The sidebar top bar and the empty list area deliberately stay silent (G2) */}
      {activeFolder && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)] shrink-0"
              data-testid="current-folder-bar"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label={t('sidebar.up')}
                    data-testid="up-folder-btn"
                    disabled={!parentFolder}
                    onClick={() => parentFolder && setActiveFolder(parentFolder)}
                  >
                    <ArrowUp size={12} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('sidebar.up')}</TooltipContent>
              </Tooltip>
              <Folder size={11} className="text-[var(--color-text-tertiary)] shrink-0" />
              {folderEdit?.mode === 'rename' && folderEdit.targetPath === activeFolder ? (
                <FolderNameInput
                  initial={folderName}
                  placeholder={t('sidebar.folderNamePlaceholder')}
                  onSubmit={submitFolderName}
                  onCancel={cancelFolderEdit}
                />
              ) : (
                <span
                  className="text-2xs text-[var(--color-text-tertiary)] truncate flex-1"
                  title={activeFolder}
                >
                  {folderName}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    data-testid="close-workspace-btn"
                    onClick={confirmCloseWorkspace}
                  >
                    <X size={12} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('sidebar.close')} ({formatShortcut('⌘⇧W')})
                </TooltipContent>
              </Tooltip>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              data-testid="side-copy-folder-path"
              onClick={() => copyText(activeFolder)}
            >
              <Copy size={13} /> {t('ctx.copyFolderPath')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="side-show-in-folder"
              onClick={() => revealInFolder(activeFolder)}
            >
              <FolderOpen size={13} /> {t('editor.showInFolder')}
            </ContextMenuItem>
            {/* Folder rows offer "New Subfolder", but the current folder itself has no row,
                so creating one directly under it needs an entry here too. */}
            <ContextMenuItem
              data-testid="side-new-folder-here"
              onClick={() => startFolderEdit({ mode: 'create', parentPath: activeFolder })}
            >
              <FolderPlus size={13} /> {t('ctx.newFolderHere')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="side-rename-folder"
              onClick={() => startFolderEdit({ mode: 'rename', targetPath: activeFolder })}
            >
              <PenLine size={13} /> {t('ctx.renameFolder')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="side-delete-folder"
              onClick={() => void handleDeleteFolder(activeFolder)}
            >
              <Trash2 size={13} /> {t('ctx.deleteFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="side-go-up"
              disabled={!parentFolder}
              onClick={() => parentFolder && setActiveFolder(parentFolder)}
            >
              <ArrowUp size={13} /> {t('ctx.goUp')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="side-close-workspace"
              disabled={workspaceLocked}
              onClick={() => void confirmCloseWorkspace()}
            >
              <X size={13} /> {t('menu.closeWorkspace')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Document list / welcome */}
      <div className="flex-1 overflow-y-auto">
        {!activeFolder && memoryOnlyDocs.length === 0 ? (
          // No folder open and no drafts: show the welcome/empty guidance. (G2)
          <WelcomeState
            onOpenFile={handleImportFile}
            onOpenFolder={handleImportFolder}
            onCreate={handleCreate}
          />
        ) : loading ? (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
            {t('editor.loading')}
          </div>
        ) : memoryOnlyDocs.length === 0 && tree.length === 0 ? (
          <EmptyState onCreate={handleCreate} onOpenFolder={handleImportFolder} />
        ) : (
          <>
            {memoryOnlyDocs.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-2xs font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
                  {t('sidebar.unsavedDrafts')}
                </div>
                <ul className="pb-1">
                  {memoryOnlyDocs.map((doc) => (
                    <TreeRow
                      key={doc.id}
                      node={memoryOnlyLeaf(doc)}
                      depth={0}
                      activeId={activeDocumentId}
                      onSelectDoc={handleSelectDoc}
                      onDeleteDoc={handleDeleteDoc}
                      onDetailsDoc={handleDetailsDoc}
                      expanded={expanded}
                      onToggleExpand={toggleExpand}
                      onExpandAll={expandAll}
                      onCopyFolderPath={copyText}
                      onShowInFolder={revealInFolder}
                      folderEdit={folderEdit}
                      onStartFolderEdit={startFolderEdit}
                      onSubmitFolderName={submitFolderName}
                      onCancelFolderEdit={cancelFolderEdit}
                      onDeleteFolder={handleDeleteFolder}
                    />
                  ))}
                </ul>
              </>
            )}
            {tree.length > 0 && (
              <ul className="py-1">
                {/* Naming a folder directly under the current folder: the current folder
                    itself has no tree row, so its temporary input row lives here. */}
                {folderEdit?.mode === 'create' && folderEdit.parentPath === activeFolder && (
                  <li className="group">
                    <div
                      data-testid="folder-create-row"
                      className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-tertiary)]"
                      style={{ paddingLeft: 24 }}
                    >
                      <Folder size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                      <FolderNameInput
                        initial=""
                        placeholder={t('sidebar.folderNamePlaceholder')}
                        onSubmit={submitFolderName}
                        onCancel={cancelFolderEdit}
                      />
                    </div>
                  </li>
                )}
                {tree.map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    activeId={activeDocumentId}
                    onSelectDoc={handleSelectDoc}
                    onDeleteDoc={handleDeleteDoc}
                    onDetailsDoc={handleDetailsDoc}
                    onEnterFolder={handleEnterFolder}
                    expanded={expanded}
                    onToggleExpand={toggleExpand}
                    onExpandAll={expandAll}
                    onCopyFolderPath={copyText}
                    onShowInFolder={revealInFolder}
                    onNewDocHere={createDocInFolder}
                    folderEdit={folderEdit}
                    onStartFolderEdit={startFolderEdit}
                    onSubmitFolderName={submitFolderName}
                    onCancelFolderEdit={cancelFolderEdit}
                    onDeleteFolder={handleDeleteFolder}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Resize handle right-click menu . Widened from `w-1` (4px) to `w-1.5` (6px) so the narrow strip is a realistic right-click target : at 4px it was almost impossible to hit */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-accent/30 active:bg-accent/50 transition-colors"
            onMouseDown={startResize}
            title={t('sidebar.resizeHint')}
            data-testid="sidebar-resize-handle"
          >
            <GripVertical
              size={12}
              className="absolute right-0 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] opacity-0 hover:opacity-100 transition-opacity"
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            data-testid="side-reset-sidebar-width"
            onClick={() => setSidebarWidth(240)}
          >
            <PanelLeft size={13} /> {t('ctx.resetSidebarWidth')}
          </ContextMenuItem>
          <ContextMenuItem data-testid="side-collapse-sidebar" onClick={toggleSidebar}>
            <PanelLeftClose size={13} /> {t('ctx.collapseSidebar')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </aside>
  )
}

// Welcome page (no folder open, no drafts) right-click menu
function WelcomeState({
  onOpenFile,
  onOpenFolder,
  onCreate,
}: {
  onOpenFile: () => void
  onOpenFolder: () => void
  onCreate: () => void
}) {
  const { t } = useT()
  // Last item of the welcome-state menu: open the search panel, the same entry point the
  // top bar and the editor empty state use.
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="px-4 py-8 text-center" data-testid="sidebar-welcome-state">
          <div className="w-12 h-12 rounded-xl bg-[var(--color-accent-muted)] flex items-center justify-center mx-auto mb-3">
            <FileText size={22} className="text-accent" />
          </div>
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
            {t('sidebar.noFolderOpen')}
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mb-4">
            {t('sidebar.openToStart')}
          </p>
          <div className="flex flex-col gap-2">
            <Button variant="accent" size="sm" onClick={onOpenFile}>
              {t('sidebar.openFileAction')}
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenFolder}>
              {t('sidebar.openFolderAction')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCreate}>
              {t('sidebar.newDocumentAction')}
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem data-testid="side-new-document" onClick={onCreate}>
          <Plus size={13} /> {t('sidebar.newDocumentAction')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="side-open-file" onClick={onOpenFile}>
          <FolderOpen size={13} /> {t('sidebar.openFileAction')}
        </ContextMenuItem>
        <ContextMenuItem data-testid="side-open-folder" onClick={onOpenFolder}>
          <Folder size={13} /> {t('sidebar.openFolderAction')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="side-search-documents" onClick={() => setSearchOpen(true)}>
          <Search size={13} /> {t('sidebar.search')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// Empty folder (a folder is open but holds no documents) right-click menu
// "Refresh" re-runs the folder list query, the same invalidation App.tsx uses when the
// on-disk folder changes; the key is a PREFIX so every per-folder list is refreshed
// without having to re-derive the exact key (and without a null-coalescing branch).
function EmptyState({
  onCreate,
  onOpenFolder,
}: {
  onCreate: () => void
  onOpenFolder: () => void
}) {
  const { t } = useT()
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [...DOCS_KEY, 'list'] })
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="px-3 py-8 text-center" data-testid="sidebar-empty-state">
          <FileText size={24} className="mx-auto mb-2 text-[var(--color-text-tertiary)]" />
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('sidebar.emptyFolder')}</p>
          <button
            onClick={onCreate}
            className="mt-2 text-xs text-accent hover:underline"
            data-testid="empty-create-btn"
          >
            {t('sidebar.createFirst')}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem data-testid="side-new-document" onClick={onCreate}>
          <Plus size={13} /> {t('sidebar.createFirst')}
        </ContextMenuItem>
        <ContextMenuItem data-testid="side-refresh" onClick={refresh}>
          <RefreshCw size={13} /> {t('ctx.refresh')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="side-open-folder" onClick={onOpenFolder}>
          <Folder size={13} /> {t('sidebar.openFolderAction')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface DocItemProps {
  doc: Document
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onDetails: () => void
  depth?: number
}

// Shared right-click / ⋯-button menu items for a document entry . Both the
// ContextMenu (right-click) and the DropdownMenu (⋯ button) feed this same subcomponent so the
// two triggers never diverge. "Rename" bridges to the editor via the store's pendingFileAction
// if the doc isn't active we switch to it first (the dirty-confirm lives in onOpen)
// before requesting the rename.
// Shared document menu item list . The right-click ContextMenu uses
// ContextMenuItem while the ⋯ DropdownMenu uses DropdownMenuItem the two Radix primitives
// are incompatible (a ContextMenuItem must live inside a ContextMenuContent), so the caller
// passes the right Item/Separator component. The data and logic are identical, so the two
// triggers can never diverge.
interface DocItemMenuContentProps {
  Item: React.ElementType
  Separator: React.ElementType
  doc: Document
  editable: boolean
  activeId: string | null
  onOpen: () => void | Promise<boolean>
  onCopyPath: () => void
  onCopyFileName: () => void
  onShowInFolder: () => void
  onCopyContent: () => void
  onDetails: () => void
  onDelete: () => void
}

function DocItemMenuContent({
  Item,
  Separator,
  doc,
  editable,
  activeId,
  onOpen,
  onCopyPath,
  onCopyFileName,
  onShowInFolder,
  onCopyContent,
  onDetails,
  onDelete,
}: DocItemMenuContentProps) {
  const { t } = useT()
  const requestFileAction = useUIStore((s) => s.requestFileAction)
  const isDraft = !doc.filePath

  const handleRename = () => {
    const run = async () => {
      if (doc.id !== activeId) {
        const switched = await onOpen()
        if (switched === false) return
      }
      requestFileAction({ type: 'rename', id: doc.id })
    }
    void run()
  }

  return (
    <>
      <Item
        data-testid="side-open-document"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <FileText size={13} /> {t('ctx.openDocument')}
      </Item>
      <Item
        data-testid="side-copy-path"
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onCopyPath()
        }}
      >
        <FileText size={13} /> {t('editor.copyFullPath')}
      </Item>
      <Item
        data-testid="side-copy-filename"
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onCopyFileName()
        }}
      >
        <FileText size={13} /> {t('ctx.copyFileName')}
      </Item>
      <Item
        data-testid="side-show-in-folder"
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onShowInFolder()
        }}
      >
        <FolderOpen size={13} /> {t('editor.showInFolder')}
      </Item>
      <Item
        data-testid="side-rename"
        disabled={!editable}
        title={!editable ? t('editor.needsEditMode') : undefined}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          handleRename()
        }}
      >
        <PenLine size={13} /> {t('editor.renameTitle')}
      </Item>
      <Item
        data-testid="side-copy-content"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onCopyContent()
        }}
      >
        <Copy size={13} /> {t('ctx.copyContent')}
      </Item>
      <Separator />
      <Item
        data-testid="side-details"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onDetails()
        }}
      >
        <FileText size={13} /> {t('sidebar.details')}
      </Item>
      <Separator />
      <Item
        data-testid={isDraft ? 'side-discard-draft' : 'side-delete'}
        destructive
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <Trash2 size={13} /> {isDraft ? t('ctx.discardDraft') : t('sidebar.delete')}
      </Item>
    </>
  )
}

function DocItem({ doc, isActive, onSelect, onDelete, onDetails, depth = 0 }: DocItemProps) {
  const { t } = useT()
  const editable = useUIStore((s) => s.editable)
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  const copyPath = () => void window.api.clipboard.writeText(doc.filePath as string)
  const copyFileName = () => void window.api.clipboard.writeText(baseName(doc.filePath as string))
  const showInFolder = () => {
    void Promise.resolve(window.api.app.showInFolder(doc.filePath as string)).catch(() => {})
  }
  const copyContent = () => void window.api.clipboard.writeText(doc.content)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-testid="doc-item"
          className={cn(
            'group relative flex items-start gap-2 px-3 py-2 mx-1 rounded cursor-pointer transition-colors',
            isActive
              ? 'bg-[var(--color-accent-muted)] text-[var(--color-text-primary)]'
              : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)]',
          )}
          style={{ paddingLeft: depth * 12 + 12 }}
          onClick={onSelect}
        >
          <FileText
            size={13}
            className={cn(
              'mt-0.5 shrink-0',
              isActive ? 'text-accent' : 'text-[var(--color-text-tertiary)]',
            )}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  'text-xs font-medium truncate',
                  // A missing document (its file was deleted outside the app) is kept open on
                  // purpose, so it stays listed here struck through, like the title bar
                  doc.missing
                    ? 'text-[var(--color-text-tertiary)] line-through'
                    : 'text-[var(--color-text-primary)]',
                )}
              >
                {/* A memory-only new document has no file on disk yet; it is listed in the dedicated "Unsaved drafts" group , falling back to its title here */}
                {doc.filePath ? baseName(doc.filePath) : doc.title}
              </span>
              {!doc.filePath && (
                <span className="text-2xs font-medium text-accent border border-accent/40 rounded px-1 py-px shrink-0">
                  {t('sidebar.newBadge')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-2xs text-[var(--color-text-tertiary)]">
                {formatDate(doc.updatedAt)}
              </span>
              {doc.wordCount > 0 && (
                <>
                  <span className="text-2xs text-[var(--color-border-strong)]">·</span>
                  <span className="text-2xs text-[var(--color-text-tertiary)]">
                    {doc.wordCount}w
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Three-dot button menu (left-click, anchored to the button). The ⋯ button keeps using DropdownMenu (: button-triggered menus stay on dropdown-menu.tsx) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-overlay)] transition-opacity',
                  isActive && 'opacity-60',
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={13} className="text-[var(--color-text-tertiary)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DocItemMenuContent
                Item={DropdownMenuItem}
                Separator={DropdownMenuSeparator}
                doc={doc}
                editable={editable}
                activeId={activeDocumentId}
                onOpen={onSelect}
                onCopyPath={copyPath}
                onCopyFileName={copyFileName}
                onShowInFolder={showInFolder}
                onCopyContent={copyContent}
                onDetails={onDetails}
                onDelete={onDelete}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      {/* Right-click menu: opens at the mouse position (native contextmenu semantics), fixing the "menu anchors to the ⋯ button" defect . Shares DocItemMenuItems with the ⋯ button so the two triggers never diverge */}
      <ContextMenuContent>
        <DocItemMenuContent
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
          doc={doc}
          editable={editable}
          activeId={activeDocumentId}
          onOpen={onSelect}
          onCopyPath={copyPath}
          onCopyFileName={copyFileName}
          onShowInFolder={showInFolder}
          onCopyContent={copyContent}
          onDetails={onDetails}
          onDelete={onDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface TreeRowProps {
  node: FileTreeNode
  depth: number
  activeId: string | null
  onSelectDoc: (doc: Document) => void
  onDeleteDoc: (doc: Document) => void
  onDetailsDoc: (doc: Document) => void
  onEnterFolder?: (folder: string) => void
  // Expand state is owned by `Sidebar` so "Expand All" can open a whole subtree
  expanded: ReadonlySet<string>
  onToggleExpand: (path: string) => void
  onExpandAll: (node: FileTreeNode) => void
  onCopyFolderPath: (path: string) => void
  onShowInFolder: (path: string) => void
  // Folders only live in the on-disk tree, so the (memory-only) drafts group never passes it.
  onNewDocHere?: (folder: string) => void
  // Inline folder naming . `folderEdit` is owned by Sidebar so the edit
  // survives the row's own re-renders; the callbacks drive it.
  folderEdit: FolderEdit | null
  onStartFolderEdit: (edit: FolderEdit) => void
  onSubmitFolderName: (name: string) => void
  onCancelFolderEdit: () => void
  onDeleteFolder: (path: string) => void
}

// The temporary <input> used to name a folder in place (①): Enter submits
// (an empty / whitespace-only name cancels), Escape or blur cancels. Pre-filled with the
// current name so a rename starts from it, selected so typing replaces it.
function FolderNameInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string
  placeholder: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  // The context menu that opened this input restores focus to its trigger as it closes. If the
  // input grabbed focus synchronously (autoFocus) it would be blurred by that restore and — once
  // blur-cancel is armed — instantly cancel itself. Focusing inside an effect (which runs after the
  // click handler and Radix's synchronous focus restore have settled) means the spurious blur has
  // already passed before the input ever holds focus, so only a genuine later blur cancels.
  const blurArmed = useRef(false)
  useEffect(() => {
    inputRef.current?.focus()
    blurArmed.current = true
  }, [])
  return (
    <input
      ref={inputRef}
      data-testid="folder-name-input"
      value={value}
      placeholder={placeholder}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (blurArmed.current) onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onCancel()
          return
        }
        if (e.key === 'Enter') {
          const name = value.trim()
          if (name) {
            onSubmit(name)
          } else {
            onCancel()
          }
        }
      }}
      className="flex-1 min-w-0 text-xs bg-[var(--color-bg)] border border-accent rounded px-1 py-0.5 outline-none"
    />
  )
}

// Recursively render the document tree: folders are collapsible, files reuse DocItem.
function TreeRow({
  node,
  depth,
  activeId,
  onSelectDoc,
  onDeleteDoc,
  onDetailsDoc,
  onEnterFolder,
  expanded,
  onToggleExpand,
  onExpandAll,
  onCopyFolderPath,
  onShowInFolder,
  onNewDocHere,
  folderEdit,
  onStartFolderEdit,
  onSubmitFolderName,
  onCancelFolderEdit,
  onDeleteFolder,
}: TreeRowProps) {
  const { t } = useT()
  const open = expanded.has(node.path)
  if (node.isFolder) {
    const renaming = folderEdit?.mode === 'rename' && folderEdit.targetPath === node.path
    return (
      <li className="group">
        <ContextMenu>
          {/* While renaming, the row must not be a button: Enter would bubble up and
              toggle the folder instead of committing the name. */}
          <ContextMenuTrigger asChild>
            {renaming ? (
              <div
                data-testid="folder-rename-row"
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-secondary)]"
                style={{ paddingLeft: depth * 12 + 12 }}
              >
                <ChevronRight
                  size={13}
                  className={cn(
                    'shrink-0 text-[var(--color-text-tertiary)] transition-transform',
                    open && 'rotate-90',
                  )}
                />
                {open ? (
                  <FolderOpen size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                ) : (
                  <Folder size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                )}
                <FolderNameInput
                  initial={node.name}
                  placeholder={t('sidebar.folderNamePlaceholder')}
                  onSubmit={onSubmitFolderName}
                  onCancel={onCancelFolderEdit}
                />
              </div>
            ) : (
              <button
                onClick={() => onToggleExpand(node.path)}
                onDoubleClick={() => onEnterFolder?.(node.path)}
                data-testid="folder-row"
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-overlay)] transition-colors truncate"
                style={{ paddingLeft: depth * 12 + 12 }}
              >
                <ChevronRight
                  size={13}
                  className={cn(
                    'shrink-0 text-[var(--color-text-tertiary)] transition-transform',
                    open && 'rotate-90',
                  )}
                />
                {open ? (
                  <FolderOpen size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                ) : (
                  <Folder size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                )}
                <span className="truncate">{node.name}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={t('sidebar.enter')}
                      data-testid="enter-folder-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEnterFolder?.(node.path)
                      }}
                      className="shrink-0 ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-overlay)] transition-opacity"
                    >
                      <ArrowRight size={13} className="text-[var(--color-text-tertiary)]" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('sidebar.enter')}</TooltipContent>
                </Tooltip>
              </button>
            )}
          </ContextMenuTrigger>
          {/* Folder row menu . The three write operations (new subfolder / rename / delete) depend on and are NOT rendered until it exists a menu item that does nothing when clicked is never allowed */}
          <ContextMenuContent>
            <ContextMenuItem
              data-testid="side-open-folder"
              onClick={() => onEnterFolder?.(node.path)}
            >
              <ArrowRight size={13} /> {t('ctx.openFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {open ? (
              <ContextMenuItem
                data-testid="side-collapse"
                onClick={() => onToggleExpand(node.path)}
              >
                <ChevronDown size={13} /> {t('ctx.collapse')}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem data-testid="side-expand" onClick={() => onToggleExpand(node.path)}>
                <ChevronRight size={13} /> {t('ctx.expand')}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              data-testid="side-expand-all"
              disabled={!node.children.some((c) => c.isFolder)}
              onClick={() => onExpandAll(node)}
            >
              <ChevronsDownUp size={13} /> {t('ctx.expandAll')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="side-copy-folder-path"
              onClick={() => onCopyFolderPath(node.path)}
            >
              <Copy size={13} /> {t('ctx.copyFolderPath')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="side-show-in-folder"
              onClick={() => onShowInFolder(node.path)}
            >
              <FolderOpen size={13} /> {t('editor.showInFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="side-new-doc-here"
              onClick={() => onNewDocHere?.(node.path)}
            >
              <Plus size={13} /> {t('ctx.newDocHere')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {/* the three write operations live here too (not only in P1). They were deferred to M3 because (createFolder/renameFolder/deleteFolder) had to land first. New subfolder enters inline create mode; rename enters inline rename mode; delete moves the folder to the trash behind a confirmation */}
            <ContextMenuItem
              data-testid="side-new-subfolder"
              onClick={() => onStartFolderEdit({ mode: 'create', parentPath: node.path })}
            >
              <FolderPlus size={13} /> {t('ctx.newSubfolder')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="side-rename-folder"
              onClick={() => onStartFolderEdit({ mode: 'rename', targetPath: node.path })}
            >
              <PenLine size={13} /> {t('ctx.renameFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="side-delete-folder"
              destructive
              onClick={() => onDeleteFolder(node.path)}
            >
              <Trash2 size={13} /> {t('ctx.deleteFolder')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {open && (
          <ul>
            {/* while a new subfolder is being named, render a temporary input row as the FIRST child so the user types the name right where the folder will appear. `parentPath` points at this node, so only its children list shows the row */}
            {folderEdit?.mode === 'create' && folderEdit.parentPath === node.path && (
              <li className="group">
                <div
                  data-testid="folder-create-row"
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-secondary)]"
                  style={{ paddingLeft: depth * 12 + 24 }}
                >
                  <ChevronRight size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <Folder size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <FolderNameInput
                    initial=""
                    placeholder={t('sidebar.folderNamePlaceholder')}
                    onSubmit={onSubmitFolderName}
                    onCancel={onCancelFolderEdit}
                  />
                </div>
              </li>
            )}
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                activeId={activeId}
                onSelectDoc={onSelectDoc}
                onDeleteDoc={onDeleteDoc}
                onDetailsDoc={onDetailsDoc}
                onEnterFolder={onEnterFolder}
                expanded={expanded}
                onToggleExpand={onToggleExpand}
                onExpandAll={onExpandAll}
                onCopyFolderPath={onCopyFolderPath}
                onShowInFolder={onShowInFolder}
                onNewDocHere={onNewDocHere}
                folderEdit={folderEdit}
                onStartFolderEdit={onStartFolderEdit}
                onSubmitFolderName={onSubmitFolderName}
                onCancelFolderEdit={onCancelFolderEdit}
                onDeleteFolder={onDeleteFolder}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const doc = node.doc
  // DocItem is only ever rendered for document nodes (the tree only mounts it
  // when `node.doc` exists), so `doc` is never null here defensive guard only
  /* v8 ignore next -- defensive: DocItem only renders for document nodes, so doc is never null here */
  if (!doc) return null
  return (
    <DocItem
      doc={doc}
      isActive={doc.id === activeId}
      depth={depth}
      onSelect={() => onSelectDoc(doc)}
      onDelete={() => void onDeleteDoc(doc)}
      onDetails={() => onDetailsDoc(doc)}
    />
  )
}
