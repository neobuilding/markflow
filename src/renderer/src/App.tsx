import React, { useCallback, useEffect, useRef } from 'react'
import { useUIStore } from './store/ui'
import { useOpenPaths } from './hooks/useDocuments'
import { Sidebar } from './components/sidebar/Sidebar'
import { EditorPane } from './components/editor/EditorPane'
import { StatusBar } from './components/editor/StatusBar'
import { CommandPalette } from './components/editor/CommandPalette'
import { NewDocumentDialog } from './components/editor/NewDocumentDialog'
import { FileDetailsDialog } from './components/editor/FileDetailsDialog'
import { AboutDialog } from './components/editor/AboutDialog'
import { ExportDialog } from './components/editor/ExportDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { buildStandaloneHtml, resolveTheme } from './lib/export'
import { getExportHtml } from './lib/exportStore'
import { queryClient, DOCS_KEY } from './lib/queryClient'
import { isDirInFolder } from './lib/utils'
import { t, useT, changeLanguage } from './i18n'
import type { Locale } from './i18n'

export default function App(): React.ReactElement {
  const { setNewDocOpen, toggleSidebar, theme, closeWorkspace, setPrinting, printing } =
    useUIStore()
  const openPathsMut = useOpenPaths()
  const openPathsMutRef = useRef(openPathsMut)
  const { t: rt } = useT()

  // Try to close the workspace, running the SAME unsaved-changes prompt used by the
  // "close workspace" menu item. Returns true if the workspace was actually closed
  // (or didn't need to be). Used both by the menu and by the app-quit flow below so
  // quitting the app is identical to closing the workspace — no separate logic / prompt.
  const tryCloseWorkspace = useCallback((): boolean => {
    const st = useUIStore.getState()
    if (st.exportOpen) {
      st.setExportOpen(false)
      return false
    }
    if (st.exporting) return false
    if (!st.dirty) {
      closeWorkspace()
      return true
    }
    // Dirty: keep this synchronous contract (before-quit needs an immediate boolean) by
    // returning false and firing an async app-modal confirm instead of blocking. If the user
    // accepts, close the workspace and tell the main process it is safe to quit. Replaces the
    // old window.confirm, whose OS-modal close triggered a window blur that broke typing.
    //
    // BEFORE opening the async confirm, tell the main process we're about to prompt the
    // user. This disarms the 5s "renderer is dead" safety net so the user has unlimited
    // time to decide; without it, the safety net would force-quit 5s after the prompt
    // opened, silently discarding the user's edits (the dirty-confirm regression).
    window.api.app.notifyQuitPending()
    void window.api.dialog
      .confirm({
        message: t('app.unsavedCloseWorkspace'),
        okText: t('app.confirmDiscard'),
        cancelText: t('app.confirmKeep'),
      })
      .then((ok: boolean) => {
        if (!ok) return
        closeWorkspace()
        window.api.app.allowQuit()
      })
    return false
  }, [closeWorkspace])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const isMac = /mac|iphone|ipad/i.test(navigator.userAgent)
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key === 'n') {
        e.preventDefault()
        setNewDocOpen(true)
      }
      if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [setNewDocOpen, toggleSidebar])

  useEffect(() => {
    if (!window.api) return
    const removeNew = window.api.onMenuEvent('new-document', () => setNewDocOpen(true))
    const removeSidebar = window.api.onMenuEvent('toggle-sidebar', () => toggleSidebar())
    const removeOpen = window.api.onMenuEvent('open-files', (data) => {
      const paths = Array.isArray(data) ? data : data ? [data as string] : []
      if (paths.length === 0) return
      openPathsMut.mutate(paths)
    })
    const removeClose = window.api.onMenuEvent('close-workspace', () => {
      tryCloseWorkspace()
    })
    const removeCloseFile = window.api.onMenuEvent('close-file', async () => {
      const st = useUIStore.getState()
      // When the export dialog is open, Cmd/Ctrl+W should close the dialog rather than the file.
      if (st.exportOpen) {
        st.setExportOpen(false)
        return
      }
      // While writing a file, fully ignore the close-file request so no path loses the workspace.
      if (st.exporting) return
      if (st.dirty) {
        const ok = await window.api.dialog.confirm({
          message: t('app.unsavedClose'),
          okText: t('app.confirmDiscard'),
          cancelText: t('app.confirmKeep'),
        })
        if (!ok) return
      }
      st.closeDocument()
    })
    const removeFileDetails = window.api.onMenuEvent('file-details', () => {
      const id = useUIStore.getState().activeDocumentId
      if (id) useUIStore.getState().setFileDetailsId(id)
    })
    const removeAbout = window.api.onMenuEvent('about', () => {
      useUIStore.getState().setAboutOpen(true)
    })
    const removeExport = window.api.onMenuEvent('export-html', () => {
      useUIStore.getState().setExportOpen(true)
    })
    const removePrint = window.api.onMenuEvent('print', async () => {
      if (!getExportHtml()) {
        window.alert(t('app.printNotReady'))
        return
      }
      if (useUIStore.getState().printing) return
      setPrinting(true)
      window.api.menu.setPrinting(true)
      try {
        const theme = resolveTheme('current', useUIStore.getState().theme)
        const html = await buildStandaloneHtml({ theme, embedImages: true })
        await window.api.export.print(html)
      } catch (e) {
        console.error('Print failed', e)
        window.alert(t('app.printFailed', { message: (e as Error)?.message || String(e) }))
      } finally {
        setPrinting(false)
        window.api.menu.setPrinting(false)
      }
    })
    const removeOpenPaths = window.api.onOpenPaths((paths) => {
      if (paths && paths.length > 0) openPathsMut.mutate(paths)
    })
    return () => {
      removeNew()
      removeSidebar()
      removeOpen()
      removeClose()
      removeCloseFile()
      removeOpenPaths()
      removeFileDetails()
      removeAbout()
      removeExport()
      removePrint()
    }
  }, [setNewDocOpen, toggleSidebar, openPathsMut, closeWorkspace, setPrinting, tryCloseWorkspace])

  // ── i18n: keep the UI language in sync with the native menu ─────────────
  // When the user picks a language in the native menu, the main process sends
  // 'menu:language'; we update the store (which persists the choice).
  useEffect(() => {
    if (!window.api) return
    const remove = window.api.onMenuEvent('language', (data) => {
      const locale = data as string
      if (locale === 'en' || locale === 'zh-CN') {
        useUIStore.getState().setLanguage(locale as Locale)
      }
    })
    return () => remove()
  }, [])

  // Push the active UI language to the main process (so the native menu's
  // labels + checked state match) and keep <html lang> in sync. Runs on mount
  // and whenever the language changes. Main does NOT echo back (notify=false),
  // so this cannot create a loop.
  useEffect(() => {
    const sync = (lang: string) => {
      document.documentElement.lang = lang
      changeLanguage(lang as Locale)
      window.api?.app?.setLanguage(lang as 'en' | 'zh-CN')
    }
    sync(useUIStore.getState().language)
    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.language !== prev.language) sync(state.language)
    })
    return () => unsub()
  }, [])

  // On startup, open paths passed via CLI arguments / file associations
  useEffect(() => {
    openPathsMutRef.current = openPathsMut
  }, [openPathsMut])

  // On startup, open paths passed via CLI arguments / file associations / drag-onto-dock.
  // Note: no workspace state is persisted; after refresh or restart, previously opened files/folders are not restored.
  useEffect(() => {
    if (!window.api?.app?.getInitialPaths) return
    window.api.app
      .getInitialPaths()
      .then((paths: string[]) => {
        if (paths && paths.length > 0) openPathsMutRef.current.mutate(paths)
      })
      .catch(() => {})
  }, [])

  // Sync the editable (read-only / edit) state to the main process, to enable/disable the native menu's Save / Save As
  useEffect(() => {
    if (!window.api?.menu?.setEditable) return
    const send = (editable: boolean) => window.api.menu.setEditable(editable)
    send(useUIStore.getState().editable)
    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.editable !== prev.editable) send(state.editable)
    })
    return () => unsub()
  }, [])

  // Sync the "has an open file" state to the main process, to enable/disable the native menu's Reload / File Details
  useEffect(() => {
    if (!window.api?.menu?.setHasDocument) return
    const send = (has: boolean) => window.api.menu.setHasDocument(has)
    send(!!useUIStore.getState().activeDocumentId)
    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.activeDocumentId !== prev.activeDocumentId) send(!!state.activeDocumentId)
    })
    return () => unsub()
  }, [])

  // When the main process wants to quit, run the exact same "close workspace" flow
  // (with its unified unsaved-changes prompt). If the user confirms (or there's nothing
  // to save), tell the main process it's safe to quit; otherwise we simply don't reply
  // and the quit is aborted. New (memory-only) docs and edits to existing files are
  // treated identically — no special quit prompt.
  useEffect(() => {
    if (!window.api?.onAppRequestQuit) return
    const remove = window.api.onAppRequestQuit(() => {
      if (tryCloseWorkspace()) window.api.app.allowQuit()
    })
    return () => remove()
  }, [tryCloseWorkspace])

  // When files are added/removed in the directory of an open document, refresh the sidebar
  // list. This does not prompt to reload the active document (that is onFileChanged's job) —
  // it only re-fetches the document list so new/deleted sibling files show up.
  //
  // The main process already coalesces a burst of folder events into one broadcast, but we
  // additionally scope the invalidation to the active folder: an event under an unrelated
  // subtree (e.g. a sibling folder the user opened but isn't currently viewing) would
  // otherwise force a refetch of the *current* folder's list, stacking onto whatever the
  // renderer is doing (notably while switching files) and showing up as intermittent lag.
  useEffect(() => {
    if (!window.api?.onFolderChanged) return
    let buf: ReturnType<typeof setTimeout> | null = null
    const remove = window.api.onFolderChanged((data) => {
      const active = useUIStore.getState().activeFolder
      // Only refresh when the event touches the folder currently displayed (or its subtree).
      // When no folder is open yet, fall back to refreshing so early events aren't lost.
      if (active && !isDirInFolder(data?.dirPath ?? '', active)) return
      // Coalesce a final burst on the renderer side too: the main-process timer already
      // merges one burst, but if several folders report near-simultaneously we still want
      // a single invalidate rather than N.
      if (buf) clearTimeout(buf)
      buf = setTimeout(() => {
        buf = null
        // Scope the refresh to the LIST only. A folder event says "the set of
        // files under this directory changed"; it says nothing about the content
        // of the document currently open, so invalidating DOCS_KEY wholesale also
        // refetches every 'detail' entry — including the active document, whose
        // refetch competes with the very switch/edit the renderer may be busy
        // with. Narrowing to the active folder's list keeps the sidebar current
        // without touching the open document.
        const active = useUIStore.getState().activeFolder
        // Two separate calls, NOT one ternary: DOCS_KEY is `as const` (a 1-tuple),
        // so a ternary mixing it with the 3-element list key makes TypeScript
        // infer the filter's key type from one branch and reject the other (TS2345).
        if (active) {
          queryClient.invalidateQueries({ queryKey: [...DOCS_KEY, 'list', active] })
        } else {
          // No folder open: fall back to refreshing everything so early
          // events are not lost (there is no list key to narrow to yet).
          queryClient.invalidateQueries({ queryKey: DOCS_KEY })
        }
      }, 300)
    })
    return () => {
      if (buf) clearTimeout(buf)
      remove()
    }
  }, [])

  // Open files/folders dragged into the window (cross-platform)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    // Don't silently discard unsaved work when a file is dropped onto the window.
    if (useUIStore.getState().dirty) {
      const ok = await window.api.dialog.confirm({
        message: t('app.unsavedClose'),
        okText: t('app.confirmDiscard'),
        cancelText: t('app.confirmKeep'),
      })
      if (!ok) return
    }
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.files.getPathForFile(f))
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (paths.length > 0) openPathsMutRef.current.mutate(paths)
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg)]"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="relative flex flex-1 min-h-0">
          <Sidebar />
          <EditorPane />
        </div>
        <StatusBar />
        <CommandPalette />
        <NewDocumentDialog />
        <FileDetailsDialog />
        <AboutDialog />
        <ExportDialog />
        {printing && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3 shadow-lg">
              <span className="text-sm text-[var(--color-text-secondary)]">
                {rt('app.preparingPrint')}
              </span>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
