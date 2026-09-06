import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FileText,
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ArrowUp,
  ArrowRight,
  X,
  GripVertical,
  PenLine,
  Copy,
} from 'lucide-react'
import {
  cn,
  formatDate,
  isInFolder,
  buildFileTree,
  isMac,
  formatShortcut,
  baseName,
  type FileTreeNode,
} from '../../lib/utils'
import { splitMemoryOnlyDocs, memoryOnlyLeaf } from '../../lib/sidebarDrafts'
import { useT } from '../../i18n'
import { useUIStore } from '../../store/ui'
import {
  useDocuments,
  useDeleteDocument,
  useCreateDocument,
  useOpenPaths,
  useOpenFolder,
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

export function Sidebar(): React.ReactElement | null {
  const {
    sidebarOpen,
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
  // Exporting (or with the export dialog open) hard-locks every "close" action, so the
  // current-folder bar's "Close Workspace" item must grey out too (PLAN §5.5).
  const workspaceLocked = useUIStore((s) => s.exporting || s.exportOpen)

  // ── Folder expand state (PLAN §6.1) ──
  // Lifted out of `TreeRow` (which used to own one `useState` per node) so an ancestor can
  // expand a whole subtree — "Expand All" has no implementation path otherwise.
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
  // for empty paths). PLAN §6.3 (G2).
  const memoryOnlyDocs = useMemo(() => splitMemoryOnlyDocs(allDocs).memoryOnly, [allDocs])

  // Only show documents within the "current folder" (empty when no folder is open, the welcome
  // page takes over). Memoized so it's a stable dependency for the tree useMemo below.
  const folderDocs = useMemo(
    () => (activeFolder ? allDocs.filter((d) => isInFolder(d.filePath, activeFolder)) : []),
    [activeFolder, allDocs],
  )

  // Build the current folder's documents into a nested "folder + file" tree, supporting subfolders
  const tree = useMemo(
    () => (activeFolder ? buildFileTree(folderDocs, activeFolder) : []),
    [folderDocs, activeFolder],
  )

  // All deletable docs for "switch to next after delete" logic, including drafts. PLAN §6.3 (G2).
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
  // confirm) so callers like the "Rename…" menu item can abort (PLAN §5.1).
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

  // PLAN §5-4: deletion is a destructive action and must be gated behind the in-app
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
  // toolbar X button and the current-folder bar's context menu (PLAN §5.5).
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
    // as an unhandled rejection — same contract as the doc-item menu.
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

  // Sidebar resize drag handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = Math.max(180, Math.min(480, e.clientX))
      setSidebarWidth(newWidth)
      document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`)
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

      {/* Current folder bar — right-click menu (PLAN §5.5). The sidebar top bar and the
          empty list area deliberately stay silent (G2). */}
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
              <span
                className="text-2xs text-[var(--color-text-tertiary)] truncate flex-1"
                title={activeFolder}
              >
                {folderName}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    data-testid="close-workspace-btn"
                    onClick={() => void confirmCloseWorkspace()}
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
              data-testid="ctx-copy-folder-path"
              onClick={() => copyText(activeFolder)}
            >
              <Copy size={13} /> {t('ctx.copyFolderPath')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="ctx-show-in-folder"
              onClick={() => revealInFolder(activeFolder)}
            >
              <FolderOpen size={13} /> {t('editor.showInFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="ctx-go-up"
              disabled={!parentFolder}
              onClick={() => parentFolder && setActiveFolder(parentFolder)}
            >
              <ArrowUp size={13} /> {t('ctx.goUp')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="ctx-close-workspace"
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
          // No folder open and no drafts: show the welcome/empty guidance. PLAN §6.3 (G2)
          <WelcomeState
            onOpenFile={handleImportFile}
            onOpenFolder={handleImportFolder}
            onCreate={handleCreate}
          />
        ) : loading ? (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
            {t('editor.loading')}
          </div>
        ) : memoryOnlyDocs.length === 0 && folderDocs.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
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
                    />
                  ))}
                </ul>
              </>
            )}
            {folderDocs.length > 0 && (
              <ul className="py-1">
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
                    onNewDocHere={(folder: string) => void createDocInFolder(folder)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-accent/30 active:bg-accent/50 transition-colors"
        onMouseDown={startResize}
        title={t('sidebar.resizeHint')}
      >
        <GripVertical
          size={12}
          className="absolute right-0 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] opacity-0 hover:opacity-100 transition-opacity"
        />
      </div>
    </aside>
  )
}

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
  return (
    <div className="px-4 py-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-[var(--color-accent-muted)] flex items-center justify-center mx-auto mb-3">
        <FileText size={22} className="text-accent" />
      </div>
      <p className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
        {t('sidebar.noFolderOpen')}
      </p>
      <p className="text-xs text-[var(--color-text-tertiary)] mb-4">{t('sidebar.openToStart')}</p>
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
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useT()
  return (
    <div className="px-3 py-8 text-center">
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

// Shared right-click / ⋯-button menu items for a document entry (PLAN §1.3 / §5). Both the
// ContextMenu (right-click) and the DropdownMenu (⋯ button) feed this same subcomponent so the
// two triggers never diverge. "Rename…" bridges to the editor via the store's pendingFileAction
// (PLAN §5.1): if the doc isn't active we switch to it first (the dirty-confirm lives in onOpen)
// before requesting the rename.
// Shared document menu item list (PLAN §1.3 / §5). The right-click ContextMenu uses
// ContextMenuItem while the ⋯ DropdownMenu uses DropdownMenuItem — the two Radix primitives
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
        data-testid="ctx-open-document"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <FileText size={13} /> {t('ctx.openDocument')}
      </Item>
      <Item
        data-testid="ctx-copy-path"
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onCopyPath()
        }}
      >
        <FileText size={13} /> {t('editor.copyFullPath')}
      </Item>
      <Item
        data-testid="ctx-copy-filename"
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onCopyFileName()
        }}
      >
        <FileText size={13} /> {t('ctx.copyFileName')}
      </Item>
      <Item
        data-testid="ctx-show-in-folder"
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onShowInFolder()
        }}
      >
        <FolderOpen size={13} /> {t('editor.showInFolder')}
      </Item>
      <Item
        data-testid="ctx-rename"
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
        data-testid="ctx-copy-content"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onCopyContent()
        }}
      >
        <Copy size={13} /> {t('ctx.copyContent')}
      </Item>
      <Separator />
      <Item
        data-testid="ctx-details"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onDetails()
        }}
      >
        <FileText size={13} /> {t('sidebar.details')}
      </Item>
      <Separator />
      <Item
        data-testid={isDraft ? 'ctx-discard-draft' : 'ctx-delete'}
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
                  // purpose, so it stays listed here — struck through, like the title bar.
                  doc.missing
                    ? 'text-[var(--color-text-tertiary)] line-through'
                    : 'text-[var(--color-text-primary)]',
                )}
              >
                {/* A memory-only new document has no file on disk yet; it is listed in the dedicated
                    "Unsaved drafts" group (PLAN §6.3), falling back to its title here. */}
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

          {/* Three-dot button menu (left-click, anchored to the button). The ⋯ button keeps
              using DropdownMenu (PLAN §1.1: button-triggered menus stay on dropdown-menu.tsx). */}
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
      {/* Right-click menu: opens at the mouse position (native contextmenu semantics), fixing the
          "menu anchors to the ⋯ button" defect (PLAN §1.5 / §5). Shares DocItemMenuItems with the
          ⋯ button so the two triggers never diverge (PLAN §1.3). */}
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
  // Expand state is owned by `Sidebar` (PLAN §6.1) so "Expand All" can open a whole subtree.
  expanded: ReadonlySet<string>
  onToggleExpand: (path: string) => void
  onExpandAll: (node: FileTreeNode) => void
  onCopyFolderPath: (path: string) => void
  onShowInFolder: (path: string) => void
  // Folders only live in the on-disk tree, so the (memory-only) drafts group never passes it.
  onNewDocHere?: (folder: string) => void
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
}: TreeRowProps) {
  const { t } = useT()
  const open = expanded.has(node.path)
  if (node.isFolder) {
    return (
      <li className="group">
        <ContextMenu>
          <ContextMenuTrigger asChild>
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
          </ContextMenuTrigger>
          {/* Folder row menu (PLAN §5.4). The three write operations (new subfolder /
              rename / delete) depend on 能力 7 and are NOT rendered until it exists — a menu
              item that does nothing when clicked is never allowed. */}
          <ContextMenuContent>
            <ContextMenuItem
              data-testid="ctx-open-folder"
              onClick={() => onEnterFolder?.(node.path)}
            >
              <ArrowRight size={13} /> {t('ctx.openFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {open ? (
              <ContextMenuItem data-testid="ctx-collapse" onClick={() => onToggleExpand(node.path)}>
                <ChevronDown size={13} /> {t('ctx.collapse')}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem data-testid="ctx-expand" onClick={() => onToggleExpand(node.path)}>
                <ChevronRight size={13} /> {t('ctx.expand')}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              data-testid="ctx-expand-all"
              disabled={!node.children.some((c) => c.isFolder)}
              onClick={() => onExpandAll(node)}
            >
              <ChevronsDownUp size={13} /> {t('ctx.expandAll')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="ctx-copy-folder-path"
              onClick={() => onCopyFolderPath(node.path)}
            >
              <Copy size={13} /> {t('ctx.copyFolderPath')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="ctx-show-in-folder"
              onClick={() => onShowInFolder(node.path)}
            >
              <FolderOpen size={13} /> {t('editor.showInFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="ctx-new-doc-here"
              onClick={() => onNewDocHere?.(node.path)}
            >
              <Plus size={13} /> {t('ctx.newDocHere')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {open && (
          <ul>
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
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const doc = node.doc
  // DocItem is only ever rendered for document nodes (the tree only mounts it
  // when `node.doc` exists), so `doc` is never null here — defensive guard only.
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
