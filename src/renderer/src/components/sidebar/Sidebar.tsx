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
  X,
  GripVertical,
} from 'lucide-react'
import {
  cn,
  formatDate,
  isInFolder,
  buildFileTree,
  isMac,
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
import type { Document } from '../../types'

export function Sidebar(): React.ReactElement | null {
  const {
    sidebarOpen,
    activeDocumentId,
    setActiveDocumentId,
    setSearchOpen,
    activeFolder,
    closeWorkspace,
  } = useUIStore()
  const { t } = useT()
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const isResizing = useRef(false)

  const { data: allDocs = [], isLoading: loading } = useDocuments()

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

  // Document select / delete / star / details: reused by the doc tree (including subfolders)
  const handleSelectDoc = useCallback(
    async (doc: Document) => {
      if (useUIStore.getState().dirty) {
        const ok = await window.api.dialog.confirm({
          message: t('app.unsavedSwitch'),
          okText: t('app.confirmDiscard'),
          cancelText: t('app.confirmKeep'),
        })
        if (!ok) return
      }
      setActiveDocumentId(doc.id)
    },
    [setActiveDocumentId, t],
  )

  const handleDeleteDoc = useCallback(
    (doc: Document) => {
      deleteMut.mutate(doc.id)
      if (activeDocumentId === doc.id) {
        const next = allListedDocs.find((d) => d.id !== doc.id)
        setActiveDocumentId(next?.id ?? null)
      }
    },
    [deleteMut, activeDocumentId, allListedDocs, setActiveDocumentId],
  )

  const handleDetailsDoc = useCallback((doc: Document) => {
    useUIStore.getState().setFileDetailsId(doc.id)
  }, [])

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
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <div className="w-5 h-5 rounded bg-accent flex items-center justify-center shrink-0">
              <FileText size={11} className="text-white" />
            </div>
            <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
              MarkFlow
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setSearchOpen(true)}>
                  <Search size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sidebar.search')} (⌘K)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleImportFile}
                  disabled={openPathsMut.isPending}
                >
                  <FolderOpen size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sidebar.openFile')} (⌘O)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleImportFolder}
                  disabled={openFolderMut.isPending}
                >
                  <Folder size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sidebar.openFolder')} (⌘⇧O)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCreate}
                  disabled={createMut.isPending}
                  data-testid="new-document-btn"
                >
                  <Plus size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sidebar.newDocument')} (⌘N)</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Current folder bar */}
      {activeFolder && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)] shrink-0">
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
                onClick={async () => {
                  if (useUIStore.getState().dirty) {
                    const ok = await window.api.dialog.confirm({
                      message: t('app.unsavedCloseWorkspace'),
                      okText: t('app.confirmDiscard'),
                      cancelText: t('app.confirmKeep'),
                    })
                    if (!ok) return
                  }
                  closeWorkspace()
                }}
              >
                <X size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('sidebar.close')} (⌘⇧W)</TooltipContent>
          </Tooltip>
        </div>
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
      <button onClick={onCreate} className="mt-2 text-xs text-accent hover:underline">
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

function DocItem({ doc, isActive, onSelect, onDelete, onDetails, depth = 0 }: DocItemProps) {
  // Controlled bottom-right menu: openable both via the three-dot button and by right-clicking the row
  const [menuOpen, setMenuOpen] = useState(false)
  const { t } = useT()
  return (
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
      onContextMenu={(e) => {
        // Right-click opens the same context menu as the three-dot button, and suppresses the
        // browser's native menu
        e.preventDefault()
        setMenuOpen(true)
      }}
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
          <span className="text-sm font-medium truncate text-[var(--color-text-primary)]">
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
              <span className="text-2xs text-[var(--color-text-tertiary)]">{doc.wordCount}w</span>
            </>
          )}
        </div>
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              onDetails()
            }}
          >
            <FileText size={13} /> {t('sidebar.details')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 size={13} /> {t('sidebar.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

interface TreeRowProps {
  node: FileTreeNode
  depth: number
  activeId: string | null
  onSelectDoc: (doc: Document) => void
  onDeleteDoc: (doc: Document) => void
  onDetailsDoc: (doc: Document) => void
}

// Recursively render the document tree: folders are collapsible, files reuse DocItem.
function TreeRow({ node, depth, activeId, onSelectDoc, onDeleteDoc, onDetailsDoc }: TreeRowProps) {
  const [open, setOpen] = useState(false)
  if (node.isFolder) {
    return (
      <li>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 w-full px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-overlay)] transition-colors truncate"
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
        </button>
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
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const doc = node.doc
  if (!doc) return null
  return (
    <DocItem
      doc={doc}
      isActive={doc.id === activeId}
      depth={depth}
      onSelect={() => onSelectDoc(doc)}
      onDelete={() => onDeleteDoc(doc)}
      onDetails={() => onDetailsDoc(doc)}
    />
  )
}
