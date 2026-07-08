import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Plus, Search, MoreHorizontal, Trash2, FolderOpen, Folder, ChevronRight, X, GripVertical } from 'lucide-react'
import { cn, formatDate, isInFolder, buildFileTree, type FileTreeNode } from '../../lib/utils'
import { useUIStore } from '../../store/ui'
import {
  useDocuments,
  useDeleteDocument,
  useCreateDocument,
  useOpenPaths,
  useOpenFolder
} from '../../hooks/useDocuments'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { Document } from '../../types'

export function Sidebar(): React.ReactElement | null {
  const {
    sidebarOpen,
    activeDocumentId,
    setActiveDocumentId,
    setSearchOpen,
    activeFolder,
    closeWorkspace
  } = useUIStore()
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const isResizing = useRef(false)

  const { data: allDocs = [], isLoading: loading } = useDocuments()

  // 仅展示“当前文件夹”内的文档（无打开文件夹时为空，由欢迎页接管）
  const folderDocs = activeFolder ? allDocs.filter((d) => isInFolder(d.filePath, activeFolder)) : []

  // 将当前文件夹内的文档构建成“文件夹 + 文件”嵌套树，支持子文件夹结构
  const tree = useMemo(
    () => (activeFolder ? buildFileTree(folderDocs, activeFolder) : []),
    [folderDocs, activeFolder]
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
    useUIStore.getState().setEditable(true) // 新建文档默认可编辑
  }, [createMut, setActiveDocumentId])

  // 文档选中 / 删除 / 星标 / 详情：供文档树（含子文件夹）复用
  const handleSelectDoc = useCallback((doc: Document) => {
    if (useUIStore.getState().dirty && !window.confirm('You have unsaved changes. Discard them and switch files?')) return
    setActiveDocumentId(doc.id)
  }, [setActiveDocumentId])

  const handleDeleteDoc = useCallback((doc: Document) => {
    deleteMut.mutate(doc.id)
    if (activeDocumentId === doc.id) {
      const next = folderDocs.find((d) => d.id !== doc.id)
      setActiveDocumentId(next?.id ?? null)
    }
  }, [deleteMut, activeDocumentId, folderDocs])

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
    ? activeFolder.split(/[\\/]/).filter(Boolean).pop() ?? activeFolder
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
          paddingLeft: typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent) ? '5rem' : '0.75rem'
        }}
      >
        <div className="titlebar-no-drag flex items-center gap-1.5 flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <div className="w-5 h-5 rounded bg-accent flex items-center justify-center shrink-0">
              <FileText size={11} className="text-white" />
            </div>
            <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate">MarkFlow</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setSearchOpen(true)}>
                  <Search size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Search (⌘K)</TooltipContent>
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
              <TooltipContent>Open File... (⌘O)</TooltipContent>
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
              <TooltipContent>Open Folder... (⌘⇧O)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleCreate} disabled={createMut.isPending}>
                  <Plus size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New Document (⌘N)</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Current folder bar */}
      {activeFolder && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)] shrink-0">
          <Folder size={11} className="text-[var(--color-text-tertiary)] shrink-0" />
          <span className="text-2xs text-[var(--color-text-tertiary)] truncate flex-1" title={activeFolder}>
            {folderName}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => {
                  if (useUIStore.getState().dirty && !window.confirm('You have unsaved changes. Discard them and close the workspace?')) return
                  closeWorkspace()
                }}
              >
                <X size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close (⌘W)</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Document list / welcome */}
      <div className="flex-1 overflow-y-auto">
        {!activeFolder ? (
          <WelcomeState
            onOpenFile={handleImportFile}
            onOpenFolder={handleImportFolder}
            onCreate={handleCreate}
          />
        ) : loading ? (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-tertiary)]">Loading…</div>
        ) : folderDocs.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
        ) : (
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
      </div>

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-accent/30 active:bg-accent/50 transition-colors"
        onMouseDown={startResize}
        title="Drag to resize sidebar"
      >
        <GripVertical size={12} className="absolute right-0 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] opacity-0 hover:opacity-100 transition-opacity" />
      </div>
    </aside>
  )
}

function WelcomeState({
  onOpenFile,
  onOpenFolder,
  onCreate
}: {
  onOpenFile: () => void
  onOpenFolder: () => void
  onCreate: () => void
}) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-[var(--color-accent-muted)] flex items-center justify-center mx-auto mb-3">
        <FileText size={22} className="text-accent" />
      </div>
      <p className="text-sm font-medium text-[var(--color-text-primary)] mb-1">No folder open</p>
      <p className="text-xs text-[var(--color-text-tertiary)] mb-4">
        Open a file or folder to start reading.
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="accent" size="sm" onClick={onOpenFile}>Open File…</Button>
        <Button variant="outline" size="sm" onClick={onOpenFolder}>Open Folder…</Button>
        <Button variant="ghost" size="sm" onClick={onCreate}>New Document</Button>
      </div>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="px-3 py-8 text-center">
      <FileText size={24} className="mx-auto mb-2 text-[var(--color-text-tertiary)]" />
      <p className="text-xs text-[var(--color-text-tertiary)]">
        No documents in this folder
      </p>
      <button onClick={onCreate} className="mt-2 text-xs text-accent hover:underline">
        Create your first document
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
  // 受控的右下角菜单：既可通过三个点按钮打开，也可通过右键整行打开
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <li
      className={cn(
        'group relative flex items-start gap-2 px-3 py-2 mx-1 rounded cursor-pointer transition-colors',
        isActive
          ? 'bg-[var(--color-accent-muted)] text-[var(--color-text-primary)]'
          : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)]'
      )}
      style={{ paddingLeft: depth * 12 + 12 }}
      onClick={onSelect}
      onContextMenu={(e) => {
        // 右键打开与三个点菜单一致的上下文菜单，并屏蔽浏览器原生菜单
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <FileText
        size={13}
        className={cn('mt-0.5 shrink-0', isActive ? 'text-accent' : 'text-[var(--color-text-tertiary)]')}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-sm font-medium truncate text-[var(--color-text-primary)]">{doc.title}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-2xs text-[var(--color-text-tertiary)]">{formatDate(doc.updatedAt)}</span>
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
              isActive && 'opacity-60'
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal size={13} className="text-[var(--color-text-tertiary)]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDetails() }}>
            <FileText size={13} /> Details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onClick={(e) => { e.stopPropagation(); onDelete() }}>
            <Trash2 size={13} /> Delete
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

// 递归渲染文档树：文件夹可折叠，文件复用 DocItem。
function TreeRow({
  node,
  depth,
  activeId,
  onSelectDoc,
  onDeleteDoc,
  onDetailsDoc
}: TreeRowProps) {
  if (node.isFolder) {
    const [open, setOpen] = useState(true)
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
              open && 'rotate-90'
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
