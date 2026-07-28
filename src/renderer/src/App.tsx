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
import { t, useT, changeLanguage } from './i18n'
import type { Locale } from './i18n'

export default function App(): React.ReactElement {
  const { setNewDocOpen, toggleSidebar, theme, closeWorkspace, setPrinting, printing } =
    useUIStore()
  const openPathsMut = useOpenPaths()
  const openPathsMutRef = useRef(openPathsMut)
  const { t: rt } = useT()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.includes('Mac')
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
      const st = useUIStore.getState()
      // When the export dialog is open, Cmd/Ctrl+W should close the dialog (not the whole workspace):
      // overwriting an existing file adds a confirmation step, and users often hit the close shortcut
      // to dismiss the dialog; closing the workspace directly would be harmful.
      if (st.exportOpen) {
        st.setExportOpen(false)
        return
      }
      // While writing a file, fully ignore the close-workspace request so no path loses the workspace.
      if (st.exporting) return
      if (st.dirty && !window.confirm(t('app.unsavedCloseWorkspace'))) return
      closeWorkspace()
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
      removeOpenPaths()
      removeFileDetails()
      removeAbout()
      removeExport()
      removePrint()
    }
  }, [setNewDocOpen, toggleSidebar, openPathsMut, closeWorkspace, setPrinting])

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

  // Open files/folders dragged into the window (cross-platform)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
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
        <div className="flex flex-1 min-h-0">
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
