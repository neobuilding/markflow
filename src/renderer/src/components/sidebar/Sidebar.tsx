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
  Eye,
} from 'lucide-react'
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
  normalizePathSegments,
  stripMarkdownExt,
  markdownExtOf,
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
  useCreateFolder,
  useRenameFolder,
  useRenameFile,
  useDeleteFolder,
  useUndoRename,
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
  ContextMenuCheckboxItem,
} from '../ui/context-menu'
import type { Document } from '../../types'

// Inline folder naming : 'create' adds a subfolder under `parentPath`,
// 'rename' renames `targetPath`. Null means no row is being named.
type FolderEdit = { mode: 'create'; parentPath: string } | { mode: 'rename'; targetPath: string }
type FileEdit =
  { mode: 'create'; parentPath: string } | { mode: 'rename'; docId: string; filePath: string }

// Turns what the user typed into the file name that will actually be used, or REFUSES it and
// hands back the `.md` spelling to show in the input instead (see submitFileName for the rules).
function resolveTypedFileName(typed: string): { name: string; refused?: string; ext?: string } {
  // A path separator is never part of a file name — a rename must not escape into another
  // directory — so it is folded to `-`, exactly as the main process already does on create.
  const flat = /[/\\]/.test(typed) ? typed.replace(/[/\\]+/g, '-') : typed
  const dot = flat.lastIndexOf('.')
  const hasExt = dot > 0
  const supported = markdownExtOf(flat)
  const name = supported ? flat : `${hasExt ? flat.slice(0, dot) : flat}.md`
  // Refused (nothing written, corrected name shown back) when the name carried a separator, or
  // an extension this app cannot open. Appending `.md` to a name with no extension at all is
  // the expected default, not a refusal.
  const refused = typed !== flat || (hasExt && !supported)
  return {
    name,
    refused: refused ? name : undefined,
    ext: hasExt && !supported ? flat.slice(dot) : undefined,
  }
}

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
    showAllFolders,
    setShowAllFolders,
    toggleShowAllFolders,
    recentlyCreatedFolders,
    markFolderCreated,
    clearCreatedFolder,
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
  // alone has no node for a folder that holds no Markdown file, so this list is what makes
  // empty folders representable at all — which is exactly why it is used as a seed only
  // when the user asks for it, or for a folder they just created.
  const { data: folderDirs = [] } = useFolderDirs(activeFolder)

  // The seed handed to buildFileTree:
  //   • "Show All Folders" ON → every on-disk folder, empty ones included.
  //   • OFF (default)         → nothing, so the tree comes from documents alone and only
  //                             folders that transitively hold Markdown exist as nodes.
  //   • in between            → a folder the user just created is pinned in even while
  //                             empty; otherwise naming a new folder would look like it did
  //                             nothing, because the filter would drop it straight back out.
  // buildFileTree walks a seeded path segment by segment, so seeding a deep folder also
  // creates the ancestors needed to reach it.
  const seededFolders = useMemo(() => {
    if (showAllFolders) return folderDirs
    const pinned = new Set(
      [...recentlyCreatedFolders].map((p) =>
        normalizePathSegments(p).replace(/\/$/, '').toLowerCase(),
      ),
    )
    return folderDirs.filter((d) =>
      pinned.has(normalizePathSegments(d).replace(/\/$/, '').toLowerCase()),
    )
  }, [showAllFolders, folderDirs, recentlyCreatedFolders])

  // Build the current folder's documents into a nested "folder + file" tree, supporting subfolders
  const tree = useMemo(
    () => (activeFolder ? buildFileTree(folderDocs, activeFolder, seededFolders) : []),
    [folderDocs, activeFolder, seededFolders],
  )

  // A pinned folder stops being "new" as soon as it holds Markdown: the per-document walk
  // then creates its node anyway, so the pin is dead weight and is dropped. Pruning here
  // (during the render that already has both inputs) avoids wiring a watcher for it.
  useEffect(() => {
    if (recentlyCreatedFolders.size === 0) return
    for (const pinned of recentlyCreatedFolders) {
      const norm = normalizePathSegments(pinned).replace(/\/$/, '').toLowerCase()
      const holdsDoc = folderDocs.some((d) => {
        const dir = normalizePathSegments(dirName(d.filePath)).replace(/\/$/, '').toLowerCase()
        return dir === norm || dir.startsWith(norm + '/')
      })
      if (holdsDoc) clearCreatedFolder(pinned)
    }
  }, [folderDocs, recentlyCreatedFolders, clearCreatedFolder])

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
  // Inline file naming (background menu's "New File"): same in-place pattern as folders.
  const [fileEdit, setFileEdit] = useState<FileEdit | null>(null)
  // Note shown under the inline file-name input when a commit was refused, so the user can see
  // WHY the name changed instead of only seeing that it did.
  const [fileHint, setFileHint] = useState<{ text: string } | null>(null)
  // "New File in This Folder": open the SAME inline name row the tree-area "New File" uses,
  // so creating inside a subfolder behaves exactly like creating at the root — the user types
  // the name instead of being handed an auto-named "Untitled". (The file itself is still a real
  // on-disk file: submitFileName creates with memoryOnly:false.)
  const createDocInFolder = useCallback((folder: string) => {
    setFileEdit({ mode: 'create', parentPath: folder })
    // The subfolder may be collapsed, and the temporary row only renders inside an open one
    // — same reason startFolderEdit expands the parent for a new subfolder.
    setExpanded((prev) => new Set(prev).add(folder))
  }, [])

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
  // Restored focus target after a rename: set by the file/folder name commits so the row that
  // was just renamed grabs focus back (see the useEffect below).
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const createFolderMut = useCreateFolder()
  const renameFolderMut = useRenameFolder()
  const renameFileMut = useRenameFile()
  const deleteFolderMut = useDeleteFolder()
  const undoRenameMut = useUndoRename()

  const startFolderEdit = useCallback((edit: FolderEdit) => {
    setFolderEdit(edit)
    // A new subfolder does not exist yet, so its parent has to be expanded for the
    // temporary input row to be visible.
    if (edit.mode === 'create') {
      setExpanded((prev) => new Set(prev).add(edit.parentPath))
    }
  }, [])

  const cancelFolderEdit = useCallback(() => setFolderEdit(null), [])

  // Inline rename of a document: flips its row into an <input> and names it in place, then
  // moves the file on disk directly. Deliberately decoupled from edit mode — renaming is a
  // file operation (like copy/delete), not a content edit, so it works read-only and for any
  // file, not just the one open in the editor, and needs no save to persist.
  const startFileRename = useCallback((doc: Document) => {
    // A memory-only draft has no path on disk yet, so it has nothing to rename in place;
    // naming it is a save-as, not a move. The rename menu item is disabled for drafts, so
    // this early return is defensive only.
    /* v8 ignore next -- defensive: the rename menu item is disabled for drafts (no filePath) */
    if (!doc.filePath) return
    setFileEdit({ mode: 'rename', docId: doc.id, filePath: doc.filePath })
  }, [])

  const cancelFileEdit = useCallback(() => {
    setFileEdit(null)
    setFileHint(null)
  }, [])

  const submitFolderName = useCallback(
    async (name: string) => {
      /* v8 ignore next -- defensive: the inline input only renders while folderEdit is set */
      if (!folderEdit) return
      try {
        if (folderEdit.mode === 'create') {
          const target = joinPath(folderEdit.parentPath, name)
          await createFolderMut.mutateAsync(target)
          // Pin it: an empty folder is filtered out of the tree by default, so without
          // this the folder would vanish the moment the user finishes naming it.
          markFolderCreated(target)
        } else {
          const newPath = joinPath(dirName(folderEdit.targetPath), name)
          await renameFolderMut.mutateAsync({ oldPath: folderEdit.targetPath, newPath })
          // A folder created this session is pinned because it is still empty, and the
          // pin is a path. Renaming has to move it (and any pin below it) onto the new
          // path: left behind, the pin matches nothing on disk any more and the folder
          // — still empty — is filtered straight back out of the tree.
          for (const pinned of useUIStore.getState().recentlyCreatedFolders) {
            if (isDirInFolder(pinned, folderEdit.targetPath)) {
              markFolderCreated(newPath + pinned.slice(folderEdit.targetPath.length))
              clearCreatedFolder(pinned)
            }
          }
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
          // Hand the focus back to the renamed row so Ctrl+Z can undo it right away. It has
          // to live INSIDE this branch: `newPath` is scoped to it (declared just above), and
          // referencing it after the branch is a ReferenceError at runtime.
          setFocusPath(newPath)
        }
        setFolderEdit(null)
      } catch (e) {
        // A name clash or a permission error rejects the mutation: keep the inline input
        // open so the user can pick another name instead of losing what they typed.
        console.error('Folder operation failed', e)
      }
    },
    [folderEdit, createFolderMut, renameFolderMut, markFolderCreated, clearCreatedFolder],
  )

  // "New File" from the background menu: name it in place, then write a real Markdown file
  // into the folder — a memory-only draft has no path and would land in "Unsaved drafts".
  //
  // The name the user types decides the extension:
  //   • no extension at all                              → `.md` is appended (they forgot it)
  //   • an extension the app can open (.md/.markdown/.mdx/…) → used exactly as typed
  //   • any other extension                              → REFUSED, and the `.md` spelling is
  //     handed back so the input can show it instead of silently writing an unopenable file.
  // A leading dot is not an extension (`.gitignore` has none), matching how the platform and
  // the main process read file names.
  const submitFileName = useCallback(
    async (name: string): Promise<string | undefined> => {
      /* v8 ignore next -- defensive: the inline input only renders while fileEdit is set */
      if (!fileEdit) return undefined
      const trimmed = name.trim()
      // The inline input only submits a non-empty name (an empty one is cancelled by the input
      // itself), so this guard is defensive — keep it so a blank commit never reaches disk.
      /* v8 ignore next -- defensive: the inline input only submits a non-empty name */
      if (!trimmed) {
        setFileEdit(null)
        return undefined
      }
      setFileHint(null)
      const resolved = resolveTypedFileName(trimmed)
      // A name this app cannot open (or one that would escape the folder): refuse the commit
      // and hand the corrected name back, so the row stays open showing it instead of
      // writing a file that could never be read again — and say why, under the input.
      if (resolved.refused !== undefined) {
        setFileHint({
          text: resolved.ext
            ? t('sidebar.unsupportedExt', { ext: resolved.ext })
            : t('sidebar.unsupportedName', { name: resolved.refused }),
        })
        return resolved.refused
      }
      const fileName = resolved.name
      try {
        if (fileEdit.mode === 'create') {
          const doc = await createMut.mutateAsync({
            // `ext` drives the real file name in the main process, so the extension the user
            // typed is what lands on disk; the title stays extension-less as stored elsewhere.
            title: stripMarkdownExt(fileName),
            ext: markdownExtOf(fileName),
            folderPath: fileEdit.parentPath,
            memoryOnly: false,
          })
          setFileEdit(null)
          setActiveDocumentId(doc.id)
          useUIStore.getState().setEditable(true)
          useUIStore.getState().setIsNewUnsaved(false)
        } else {
          // Rename: a direct on-disk move — no edit-mode switch and no save.
          const newPath = joinPath(dirName(fileEdit.filePath), fileName)
          await renameFileMut.mutateAsync({ oldPath: fileEdit.filePath, newPath })
          setFileEdit(null)
          setFocusPath(newPath)
        }
      } catch (e) {
        // A name clash or a permission error rejects the mutation: keep the inline input
        // open so the user can pick another name instead of losing what they typed.
        console.error('File operation failed', e)
      }
      return undefined
    },
    [fileEdit, createMut, renameFileMut, setActiveDocumentId, t],
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
        // Never silent: a failed trash move used to leave the folder sitting in the tree
        // with no explanation at all, and the OS-level error behind it is easy to miss.
        window.alert(t('app.deleteFolderFailed', { name: baseName(folderPath) }))
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

  // F2 — rename whichever sidebar row currently holds focus. Bound on the sidebar root, so
  // a keypress anywhere else in the app (notably the editor) never reaches it: the editor's
  // own text editing keeps its own F2-free behaviour and Ctrl+Z stays text undo.
  const handleSidebarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl/Cmd+Z inside the sidebar undoes the last RENAME. This handler is bound on the
      // sidebar root, so a keypress in the editor never reaches it — the editor's own Ctrl+Z
      // therefore stays text undo, and anywhere outside both there is simply no handler.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undoRenameMut.mutateAsync().then((res) => {
          // 'none' simply means there is no rename to undo, which must stay silent — pressing
          // Ctrl+Z in an untouched sidebar should do nothing at all. Every OTHER refusal has
          // to be explained instead of silently doing nothing.
          if (!res?.ok && res?.reason && res.reason !== 'none') {
            window.alert(t('app.renameUndoBlocked'))
          }
        })
        return
      }
      if (e.key !== 'F2') return
      const target = e.target as HTMLElement | null
      const row = target?.closest?.('[data-kind]') as HTMLElement | null
      if (!row) return
      const path = row.dataset.path
      // A memory-only draft has no path on disk and cannot be renamed (its menu item is
      // disabled for the same reason), so there is nothing to start.
      if (!path) return
      e.preventDefault()
      if (row.dataset.kind === 'folder') {
        startFolderEdit({ mode: 'rename', targetPath: path })
        return
      }
      const doc = allDocs.find((d) => d.filePath === path)
      if (doc) startFileRename(doc)
    },
    [allDocs, startFolderEdit, startFileRename, undoRenameMut, t],
  )

  const asideRef = useRef<HTMLElement>(null)
  // Put focus back on the row that was just renamed. The inline input unmounts on commit, so
  // without this the focus would fall to <body> — and the sidebar-scoped Ctrl+Z (rename undo)
  // would be unreachable at the exact moment the user wants it most.
  useEffect(() => {
    if (!focusPath) return
    let frame = 0
    let tries = 0
    const grab = (): void => {
      // Compared via dataset rather than a CSS attribute selector: Windows paths contain
      // backslashes, which would have to be escaped inside a selector string.
      const rows = asideRef.current?.querySelectorAll<HTMLElement>('[data-path]')
      const hit = rows && Array.from(rows).find((el) => el.dataset.path === focusPath)
      if (hit) {
        hit.focus()
        setFocusPath(null)
        return
      }
      // The renamed row only exists once the refetch triggered by the rename has landed,
      // so retry for a few frames instead of assuming it is already there.
      if (tries++ < 10) frame = requestAnimationFrame(grab)
      else setFocusPath(null)
    }
    grab()
    return () => cancelAnimationFrame(frame)
  }, [focusPath])

  if (!sidebarOpen) return null

  const folderName = activeFolder
    ? (activeFolder.split(/[\\/]/).filter(Boolean).pop() ?? activeFolder)
    : ''

  // A create row aimed at the current folder itself (as opposed to one of its subfolders).
  // It must render even when the tree is empty: otherwise "New Folder" from the empty state
  // would set the edit state and then show nothing, making the menu item look broken.
  const rootCreatePending =
    (folderEdit?.mode === 'create' && folderEdit.parentPath === activeFolder) ||
    (fileEdit?.mode === 'create' && fileEdit.parentPath === activeFolder)

  return (
    <aside
      className="relative flex flex-col h-full border-r border-[var(--color-border)] bg-[var(--color-bg)] shrink-0 animate-slide-in-left"
      style={{ width: sidebarWidth }}
      onKeyDown={handleSidebarKeyDown}
      ref={asideRef}
      // Makes the whole sidebar a focus target: clicking a row, the tree background or any
      // non-focusable part of it focuses the SIDEBAR itself (the nearest focusable ancestor),
      // so Ctrl+Z counts as "focus is in the sidebar" without needing a specific row focused.
      tabIndex={-1}
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
                  aria-label={t('sidebar.newDraft')}
                  onClick={handleCreate}
                  disabled={createMut.isPending}
                  data-testid="new-document-btn"
                >
                  <Plus size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('sidebar.newDraft')} ({formatShortcut('⌘N')})
              </TooltipContent>
            </Tooltip>
            {/* "Show All Folders": opt-in reveal of folders that hold no Markdown. Only
                meaningful while a folder is open. Shares one store flag with the
                background right-click menu, so the two can never disagree. */}
            {activeFolder && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('sidebar.showAllFolders')}
                    aria-pressed={showAllFolders}
                    data-testid="show-all-folders-btn"
                    onClick={toggleShowAllFolders}
                    className={cn(showAllFolders && 'text-accent')}
                  >
                    <Eye size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('sidebar.showAllFoldersHint')}</TooltipContent>
              </Tooltip>
            )}
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
                  size="folder"
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
          <ContextMenuContent
            // Radix returns focus to the trigger as the menu closes. For the create items that
            // is fatal: unlike rename (which swaps the row out), the trigger row STAYS mounted,
            // so the restore blurs the freshly opened inline input and blur-cancel closes it.
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
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

      {/* Document list / welcome . The area itself is now right-clickable: while the tree
          is populated this used to be the one dead zone in the sidebar (G2 kept it silent). */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex-1 overflow-y-auto" data-testid="sidebar-tree-area">
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
            ) : memoryOnlyDocs.length === 0 && tree.length === 0 && !rootCreatePending ? (
              <EmptyState
                onNewFile={() =>
                  activeFolder && setFileEdit({ mode: 'create', parentPath: activeFolder })
                }
                onNewFolder={() =>
                  activeFolder && startFolderEdit({ mode: 'create', parentPath: activeFolder })
                }
                showAllFolders={showAllFolders}
                onToggleShowAllFolders={setShowAllFolders}
              />
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
                          fileEdit={fileEdit}
                          fileNameHint={fileHint}
                          onStartFileRename={startFileRename}
                          onSubmitFileName={submitFileName}
                          onCancelFileEdit={cancelFileEdit}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {/* Naming a folder / file directly under the current folder: the current folder
                itself has no tree row, so its temporary input row lives here — outside the
                tree list, so it still appears when the folder holds nothing yet. */}
                {rootCreatePending && (
                  <ul className="py-1">
                    {folderEdit?.mode === 'create' && folderEdit.parentPath === activeFolder && (
                      <li className="group">
                        <div
                          data-testid="folder-create-row"
                          className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-tertiary)]"
                          style={{ paddingLeft: 24 }}
                        >
                          <Folder
                            size={13}
                            className="shrink-0 text-[var(--color-text-tertiary)]"
                          />
                          <FolderNameInput
                            initial=""
                            size="folder"
                            placeholder={t('sidebar.folderNamePlaceholder')}
                            onSubmit={submitFolderName}
                            onCancel={cancelFolderEdit}
                          />
                        </div>
                      </li>
                    )}
                    {/* Naming a new Markdown file directly under the current folder. */}
                    {fileEdit?.mode === 'create' && fileEdit.parentPath === activeFolder && (
                      <li className="group">
                        <div
                          data-testid="file-create-row"
                          className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-tertiary)]"
                          style={{ paddingLeft: 24 }}
                        >
                          <FileText
                            size={13}
                            className="shrink-0 text-[var(--color-text-tertiary)]"
                          />
                          <FolderNameInput
                            initial=""
                            hint={fileHint}
                            placeholder={t('sidebar.fileNamePlaceholder')}
                            onSubmit={submitFileName}
                            onCancel={() => setFileEdit(null)}
                          />
                        </div>
                      </li>
                    )}
                  </ul>
                )}
                {tree.length > 0 && (
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
                        onNewDocHere={createDocInFolder}
                        folderEdit={folderEdit}
                        onStartFolderEdit={startFolderEdit}
                        onSubmitFolderName={submitFolderName}
                        onCancelFolderEdit={cancelFolderEdit}
                        onDeleteFolder={handleDeleteFolder}
                        fileEdit={fileEdit}
                        fileNameHint={fileHint}
                        onStartFileRename={startFileRename}
                        onSubmitFileName={submitFileName}
                        onCancelFileEdit={cancelFileEdit}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          // See the current-folder bar menu: the create items keep this trigger mounted, so
          // Radix's focus restore would blur (and thus cancel) the inline input it just opened.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {/* Both create items need an open folder. The guard sits here — while rendering —
              rather than inside each click handler: with no folder open this menu is
              unreachable, so an in-handler check could never be exercised. */}
          {activeFolder && (
            <>
              <ContextMenuItem
                data-testid="side-bg-new-folder"
                onClick={() => startFolderEdit({ mode: 'create', parentPath: activeFolder })}
              >
                <FolderPlus size={13} /> {t('ctx.newFolderHere')}
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="side-bg-new-file"
                onClick={() => setFileEdit({ mode: 'create', parentPath: activeFolder })}
              >
                <Plus size={13} /> {t('sidebar.newFile')}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          {/* Same flag as the toolbar button: one source of truth, never two states. */}
          <ContextMenuCheckboxItem
            data-testid="side-bg-show-all-folders"
            checked={showAllFolders}
            onCheckedChange={(v) => setShowAllFolders(v === true)}
          >
            {t('sidebar.showAllFolders')}
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>

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
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
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
              {t('sidebar.newDraft')}
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem data-testid="side-new-document" onClick={onCreate}>
          <Plus size={13} /> {t('sidebar.newDraft')}
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

// Empty folder (a folder is open but holds no documents) right-click menu. Kept in step
// with the tree-area menu: both offer creating, and both drive the same "Show All Folders"
// flag. "Refresh" is deliberately absent — the main process already watches the folder
// (chokidar), so the listing updates on its own without a manual nudge.
function EmptyState({
  onNewFile,
  onNewFolder,
  showAllFolders,
  onToggleShowAllFolders,
}: {
  onNewFile: () => void
  onNewFolder: () => void
  showAllFolders: boolean
  onToggleShowAllFolders: (v: boolean) => void
}) {
  const { t } = useT()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        <div className="px-3 py-8 text-center" data-testid="sidebar-empty-state">
          <FileText size={24} className="mx-auto mb-2 text-[var(--color-text-tertiary)]" />
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('sidebar.emptyFolder')}</p>
          <button
            onClick={onNewFile}
            className="mt-2 text-xs text-accent hover:underline"
            data-testid="empty-create-btn"
          >
            {t('sidebar.createFirst')}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        // Same reason as the other create-capable menus: the inline create row must keep the
        // focus it just grabbed instead of losing it to the trigger being restored.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* A real Markdown file written straight into the open folder — the natural thing to
            want from an empty folder, and what the background menu also offers. No "New Draft"
            here: the sidebar manages the current folder, so it only creates on-disk files. */}
        <ContextMenuItem data-testid="side-empty-new-file" onClick={onNewFile}>
          <Plus size={13} /> {t('sidebar.newFile')}
        </ContextMenuItem>
        {/* Distinct id from the current-folder bar's "New Folder Here" item (line ~651):
            both menus offer it, but sharing one testid made the two entry points
            indistinguishable to tests. */}
        <ContextMenuItem data-testid="side-empty-new-folder" onClick={onNewFolder}>
          <FolderPlus size={13} /> {t('ctx.newFolderHere')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          data-testid="side-show-all-folders"
          checked={showAllFolders}
          onCheckedChange={(v) => onToggleShowAllFolders(v === true)}
        >
          {t('sidebar.showAllFolders')}
        </ContextMenuCheckboxItem>
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
  renaming?: boolean
  onStartFileRename: () => void
  onSubmitRename: (name: string) => void
  onCancelRename: () => void
  // Note shown under the inline rename input when the typed name was refused.
  renameHint?: { text: string } | null
  depth?: number
}

// Shared right-click / ⋯-button menu items for a document entry. Both the
// ContextMenu (right-click) and the DropdownMenu (⋯ button) feed this same subcomponent so the
// two triggers never diverge. "Rename" enters an inline in-place rename in the sidebar; on
// commit it moves the file on disk directly (decoupled from edit mode and the open document).
// Shared document menu item list. The right-click ContextMenu uses
// ContextMenuItem while the ⋯ DropdownMenu uses DropdownMenuItem — the two Radix primitives
// are incompatible (a ContextMenuItem must live inside a ContextMenuContent), so the caller
// passes the right Item/Separator component. The data and logic are identical, so the two
// triggers can never diverge.
interface DocItemMenuContentProps {
  Item: React.ElementType
  Separator: React.ElementType
  doc: Document
  onOpen: () => void | Promise<boolean>
  onStartFileRename: () => void
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
  onOpen,
  onStartFileRename,
  onCopyPath,
  onCopyFileName,
  onShowInFolder,
  onCopyContent,
  onDetails,
  onDelete,
}: DocItemMenuContentProps) {
  const { t } = useT()
  const isDraft = !doc.filePath

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
        disabled={isDraft}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          onStartFileRename()
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

function DocItem({
  doc,
  isActive,
  onSelect,
  onDelete,
  onDetails,
  renaming = false,
  onStartFileRename,
  onSubmitRename,
  onCancelRename,
  renameHint,
  depth = 0,
}: DocItemProps) {
  const { t } = useT()
  // While renaming, swap the whole row for an inline input (the context menu has closed by
  // then). No edit-mode switch and no save: a file rename is a direct on-disk move, so it
  // works read-only and for any file — not just the open one.
  if (renaming && doc.filePath) {
    return (
      <li className="group">
        <div
          data-testid="file-rename-row"
          className="flex items-center gap-1.5 w-full px-3 py-2 mx-1 rounded text-xs font-medium text-[var(--color-text-secondary)]"
          style={{ paddingLeft: depth * 12 + 12 }}
        >
          <FileText size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
          <FolderNameInput
            // Prefilled with the FULL base name, extension included: the extension is part of
            // the name the user is editing and must be as editable as the rest of it.
            initial={baseName(doc.filePath)}
            size="file"
            hint={renameHint}
            placeholder={t('sidebar.fileNamePlaceholder')}
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          />
        </div>
      </li>
    )
  }
  const copyPath = () => void window.api.clipboard.writeText(doc.filePath as string)
  const copyFileName = () => void window.api.clipboard.writeText(baseName(doc.filePath as string))
  const showInFolder = () => {
    void Promise.resolve(window.api.app.showInFolder(doc.filePath as string)).catch(() => {})
  }
  const copyContent = () => void window.api.clipboard.writeText(doc.content)
  return (
    <ContextMenu>
      {/* Nested inside the tree-area menu: a row's own menu must win, so the event is
          stopped here instead of letting it bubble up and open both menus at once. */}
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        <li
          data-testid="doc-item"
          // F2 needs to know WHICH row has focus; the handler walks up from the event
          // target to the nearest element carrying these attributes.
          data-kind="doc"
          data-path={doc.filePath ?? ''}
          // Rows must be a real tab stop. Without it a click leaves focus on <body>, so the
          // sidebar's F2 / Ctrl+Z handler (bound on the sidebar root) never receives the
          // keypress at all — the shortcut silently did nothing.
          tabIndex={0}
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
                onOpen={onSelect}
                onStartFileRename={onStartFileRename}
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
          onOpen={onSelect}
          onStartFileRename={onStartFileRename}
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
  // Inline file naming (create / rename). Owned by Sidebar so it survives row re-renders;
  // `fileEdit` drives the inline input and the callbacks commit/cancel it.
  fileEdit: FileEdit | null
  // Note shown under the inline file-name input when the typed name was refused.
  fileNameHint: { text: string } | null
  onStartFileRename: (doc: Document) => void
  onSubmitFileName: (name: string) => void
  onCancelFileEdit: () => void
}

// The temporary <input> used to name a folder in place (①): Enter submits
// (an empty / whitespace-only name cancels), Escape or blur cancels. Pre-filled with the
// current name so a rename starts from it, selected so typing replaces it.
//
// `size` picks the font the ROW prints its name in — `folder` for the folder rows
// (`text-base`), `file` for the file rows (`text-xs`). Naming a folder with the file
// size (or the other way round) makes the row jump while typing.
function FolderNameInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
  hint,
  size = 'file',
}: {
  initial: string
  placeholder: string
  // Answers with a corrected name when the commit was REFUSED (e.g. an extension this app
  // cannot open): nothing is written, the row stays open and shows that name instead.
  // Sync (fire-and-forget) or async, so the folder flows can stay plain callbacks.
  onSubmit: (name: string) => Promise<string | void> | void
  onCancel: () => void
  size?: 'folder' | 'file'
  // A one-line note under the input explaining why a commit was refused (e.g. an extension the
  // app cannot open). Wrapped in an object so every refusal is a NEW value and re-shows it.
  hint?: { text: string } | null
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  // The context menu that opened this input restores focus to its trigger as it closes. If the
  // input grabbed focus synchronously (autoFocus) it would be blurred by that restore and — once
  // blur-cancel is armed — instantly cancel itself. Focusing inside an effect (which runs after the
  // click handler and Radix's synchronous focus restore have settled) means the spurious blur has
  // already passed before the input ever holds focus, so only a genuine later blur cancels.
  const blurArmed = useRef(false)
  // The note is transient: it explains the LAST refusal and must get out of the way as soon as
  // the user types again, so it is hidden locally — the parent need not be involved. Visibility is
  // derived from `hint` plus a local "dismissed" flag; the flag resets whenever a *fresh* refusal
  // arrives (hint changes to a new value), so two refusals in a row both show. Derived in render
  // (not in an effect) to avoid a cascading setState-on-effect.
  const [hintVisible, setHintVisible] = useState(false)
  // Show the note whenever a refusal is set. The setState-in-effect is deliberate: `hint` is
  // owned by the parent, and this is the simplest correct sync; the cascade is a single boolean.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setHintVisible(hint !== undefined && hint !== null), [hint])
  useEffect(() => {
    // Focus has to be taken AFTER the context menu that opened this input has finished
    // closing. While that menu is still closing the app behind it is not focusable, so a
    // synchronous focus() from this mount effect is silently dropped: the row renders its
    // input but leaves it unfocused, and the user has to click it before typing. So try
    // immediately (where nothing is fighting for focus that already works) and, if focus did
    // not stick, re-assert it on the next frames — bounded, so an input that can never be
    // focused cannot spin forever.
    let frame = 0
    let tries = 0
    const grab = (): void => {
      const el = inputRef.current
      /* v8 ignore next -- defensive: the ref is attached for as long as this input is mounted */
      if (!el) return
      // Unconditional: focus() on an element that already has it is a no-op, and it fires no
      // focus event, so re-asserting never re-runs the select-on-focus above.
      el.focus()
      // Bounded on purpose: an input that can never take focus must not reschedule itself
      // forever (that would spin a frame loop for the lifetime of the row).
      if (document.activeElement !== el && tries++ < 8) {
        frame = requestAnimationFrame(grab)
      }
    }
    grab()
    // Armed from mount, exactly as before: blur-cancel only ever reacts to a real blur away
    // from a focused input, so it must not depend on whether the grab above succeeded. The
    // retry is about *taking* focus, never about suppressing cancellation.
    blurArmed.current = true
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="flex-1 min-w-0">
      <input
        ref={inputRef}
        data-testid="folder-name-input"
        value={value}
        placeholder={placeholder}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          setValue(e.target.value)
          setHintVisible(false)
        }}
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
            if (!name) {
              onCancel()
              return
            }
            void Promise.resolve(onSubmit(name)).then((corrected) => {
              if (typeof corrected === 'string') setValue(corrected)
            })
          }
        }}
        className={cn(
          'w-full min-w-0 bg-[var(--color-bg)] border border-accent rounded px-1 py-0.5 outline-none',
          size === 'folder' ? 'text-base' : 'text-xs',
        )}
      />
      {hint && hintVisible ? (
        <span
          data-testid="file-name-hint"
          className="mt-0.5 block text-[10px] leading-tight text-[var(--color-text-tertiary)]"
        >
          {hint.text}
        </span>
      ) : null}
    </div>
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
  fileEdit,
  fileNameHint,
  onStartFileRename,
  onSubmitFileName,
  onCancelFileEdit,
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
          <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
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
                  size="folder"
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
                data-kind="folder"
                data-path={node.path}
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
          <ContextMenuContent
            // "New Subfolder" keeps this row mounted (rename swaps it out instead), so Radix's
            // focus restore would blur — and thereby cancel — the inline input it just opened.
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
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
              <Plus size={13} /> {t('ctx.newFileHere')}
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
                    size="folder"
                    placeholder={t('sidebar.folderNamePlaceholder')}
                    onSubmit={onSubmitFolderName}
                    onCancel={onCancelFolderEdit}
                  />
                </div>
              </li>
            )}
            {/* The same temporary row for a new Markdown file inside THIS subfolder. Distinct
                testid from the root "file-create-row": both menus can drive it, and tests must
                be able to tell the two entry points apart. */}
            {fileEdit?.mode === 'create' && fileEdit.parentPath === node.path && (
              <li className="group">
                <div
                  data-testid="sub-file-create-row"
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-base font-medium text-[var(--color-text-secondary)]"
                  style={{ paddingLeft: depth * 12 + 24 }}
                >
                  <FileText size={13} className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <FolderNameInput
                    initial=""
                    hint={fileNameHint}
                    placeholder={t('sidebar.fileNamePlaceholder')}
                    onSubmit={onSubmitFileName}
                    onCancel={onCancelFileEdit}
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
                fileEdit={fileEdit}
                fileNameHint={fileNameHint}
                onStartFileRename={onStartFileRename}
                onSubmitFileName={onSubmitFileName}
                onCancelFileEdit={onCancelFileEdit}
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
      renaming={fileEdit?.mode === 'rename' && fileEdit.docId === doc.id}
      onStartFileRename={() => onStartFileRename(doc)}
      onSubmitRename={onSubmitFileName}
      onCancelRename={onCancelFileEdit}
      renameHint={fileNameHint}
      onSelect={() => onSelectDoc(doc)}
      onDelete={() => void onDeleteDoc(doc)}
      onDetails={() => onDetailsDoc(doc)}
    />
  )
}
