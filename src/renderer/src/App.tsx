import React, { useCallback, useEffect, useRef } from 'react'
import { useUIStore, selectFileLocked } from './store/ui'
import { useOpenPaths, createDraft, useHasMemoryOnlyDraft } from './hooks/useDocuments'
import { Sidebar } from './components/sidebar/Sidebar'
import { EditorPane } from './components/editor/EditorPane'
import { StatusBar } from './components/editor/StatusBar'
import { CommandPalette } from './components/editor/CommandPalette'
import { NewDocumentDialog } from './components/editor/NewDocumentDialog'
import { FileDetailsDialog } from './components/editor/FileDetailsDialog'
import { AboutDialog } from './components/editor/AboutDialog'
import { ExportDialog } from './components/editor/ExportDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { resolveTheme } from './lib/export'
import { printDocument } from './lib/printDocument'
import { routeSelectAll, createSelectAllKeydownHandler } from './lib/selectAllRouter'
import { queryClient, DOCS_KEY } from './lib/queryClient'
import { isDirInFolder } from './lib/utils'
import { hasModalSurface, isEditableTarget, isEditorSurface } from './lib/shortcut-scope'
import { moveNavigationHistory, navigateToPath } from './lib/documentNavigation'
import { maybeDecideExternalPaths } from './lib/workspaceExternalDecision'
import { matchFormatShortcut } from './lib/format-shortcuts'
import { t, changeLanguage } from './i18n'
import type { Locale } from './i18n'
import { acceptTabHandoff, removeTransferredTab } from './lib/tabTransfer'
import { useTabsStore } from './store/tabs'
import { buildTabHandoff } from './lib/tabHandoff'
import { showCloseAllTabsDialog } from './lib/closeTabDialog'

export default function App(): React.ReactElement {
  // Field-scoped selectors: an identity selector re-renders on every keystroke (ADR-0033).
  const theme = useUIStore((s) => s.theme)
  // Actions are stable references created once by the store initializer, so reading them via
  // getState() avoids an unnecessary subscription (Vercel rerender-defer-reads).
  const { setNewDocOpen, toggleSidebar, closeWorkspace } = useUIStore.getState()
  // Read at the app root so the native menu mirrors the same "at most one draft" rule as the
  // toolbar buttons; the list query is shared with the sidebar, so this adds no fetch.
  const draftExists = useHasMemoryOnlyDraft()
  const openPathsMut = useOpenPaths()
  const openPathsMutRef = useRef(openPathsMut)

  // Single Markdown files opened from outside the workspace (drop / file association / menu) go
  // through the shared four-way choice; everything else keeps the normal useOpenPaths funnel.
  const openPathsWithDecision = useCallback(async (paths: string[]) => {
    if (await maybeDecideExternalPaths(paths)) return
    openPathsMutRef.current.mutate(paths)
  }, [])

  // Try to close the workspace, running the SAME unsaved-changes prompt used by the
  // "close workspace" menu item. Returns true if the workspace was actually closed
  // (or didn't need to be). Used by the menu and by the main process's window-close
  // request (`app:request-quit`); in both cases the prompt is identical.
  //
  // `quit` tells the two callers apart:
  //   - true  — the MAIN process requested a WINDOW close (`app:request-quit`). The
  //             handshake (`notifyQuitPending` / `allowQuit`) belongs to that request:
  //             allowQuit lets THAT window close; it does not quit the app or other windows.
  //   - false — the "Close Workspace" MENU action, which closes the workspace in THIS
  //             window only and leaves the window (and every other window) open.
  const tryCloseWorkspace = useCallback(
    (quit: boolean): boolean => {
      const st = useUIStore.getState()
      // ADR-0040 §5.6: the capability lock (now including `saving`) and a stacked
      // native dialog both refuse the close. Disarm main's 5s safety net on EVERY
      // refusal, otherwise the renderer would be force-closed with dirty tabs.
      if (selectFileLocked(st)) {
        if (quit) window.api.app.notifyQuitPending()
        return false
      }
      // A dirty BACKGROUND tab must veto the whole close too — never trust the
      // global `dirty` mirror alone.
      const dirtyTabs = useTabsStore.getState().tabs.filter((tab) => st.isTabDirty(tab.documentId))
      // When no tab is open but the global dirty mirror is set (legacy/direct setter flows),
      // the active document's own draft still has to veto the close.
      const hasDirty = dirtyTabs.length > 0 || st.dirty
      if (!hasDirty) {
        closeWorkspace()
        return true
      }
      // Keep the synchronous boolean contract: notify main, open one aggregate dialog,
      // return false immediately; on Discard, clear all buffers and allow the close.
      if (quit) window.api.app.notifyQuitPending()
      const titles = dirtyTabs.map((tab) => tab.title).filter(Boolean)
      void showCloseAllTabsDialog(titles, t).then((ok) => {
        if (!ok) return
        const current = useUIStore.getState()
        for (const tab of dirtyTabs) current.closeTabDocument(tab.documentId)
        closeWorkspace()
        if (quit) window.api.app.allowQuit()
      })
      return false
    },
    [closeWorkspace],
  )

  useEffect(() => {
    // `window.matchMedia` is not guaranteed to exist outside a browser engine (jsdom does not
    // implement it), so the query is taken defensively — the same optional-call pattern the export
    // / print path uses in `lib/export.ts`. Without the guard the effect throws on every mount in
    // such a host; with it, `resolveTheme` degrades to 'light' and no OS listener is installed.
    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    const apply = () => {
      // Resolve the choice with the SAME helper the export / print path uses, so "system" means one
      // thing app-wide (ADR-0028). The media query is cached so a light<->dark switch while the app
      // is open updates immediately (no restart).
      document.documentElement.classList.toggle('dark', resolveTheme('current', theme) === 'dark')
    }
    apply()
    if (theme === 'system' && mq) {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // Bridge the active theme to the native shell (title bar / OS chrome) and to the native menu's
  // theme radio checkmark (the `menu.theme*` items). Runs on mount — so the initial 'system' default
  // syncs — and on every change. No persistence: the choice lives only for the session.
  useEffect(() => {
    if (window.api?.app?.setTheme) window.api.app.setTheme(theme)
  }, [theme])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // R5 plan A: printing is a document transaction. The main window stays ENABLED so the
      // preview pane can be scrolled, but global shortcuts (Ctrl+N new draft, Ctrl+\ etc.) must
      // stand down. Preview scrolling never goes through this window-level handler.
      if (useUIStore.getState().printing) return
      const isMac = /mac|iphone|ipad/i.test(navigator.userAgent)
      const mod = isMac ? e.metaKey : e.ctrlKey
      // Same modal guard as Ctrl/Cmd+F/H (lib/shortcut-scope): while a modal surface owns the
      // keyboard, stand down — and deliberately do NOT preventDefault, so the key stays available
      // to whoever does own it. Without this, Ctrl+N would stack a second dialog on top of an open
      // one and Ctrl+\ would move the sidebar behind it.
      if (hasModalSurface(document)) return
      // Browser-style document history (ADR-0038 §3.4): Alt+←/→ on Windows/Linux,
      // Cmd+[ / Cmd+] on macOS. Only outside the editor — CodeMirror owns these keys when it has
      // focus (syntax movement / indent), so stand down without preventDefault there.
      const historyKey = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '[' || e.key === ']')
        : e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      if (historyKey) {
        if (isEditorSurface(document.activeElement)) return
        e.preventDefault()
        e.stopPropagation()
        void moveNavigationHistory(e.key === 'ArrowLeft' || e.key === '[' ? -1 : 1)
        return
      }
      if (mod && e.key === 'n') {
        // VS Code parity: Ctrl/Cmd+N creates an in-memory draft immediately, never a dialog.
        // The native menu accelerator fires the same action through 'menu:new-document'; the
        // shared createDraft() collapses both paths so one key press can never create two drafts.
        e.preventDefault()
        void createDraft()
      }
      if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
      // Find in Files (Ctrl/Cmd+Shift+F) → open the resident Search view (in the sidebar) and focus
      // its input. It is editor-agnostic and lives in the sidebar so it survives a focused editor
      // (ADR-0023).
      //
      // NOTE: plain Ctrl/Cmd+H is deliberately NOT claimed here. It belongs to the editor's
      // find/replace widget (VS Code parity: Ctrl+H = Replace in the current document), which is
      // opened by EditorPane's own guarded window handler. Claiming it here — and doing so from a
      // capture-phase listener that calls stopPropagation — would win the race and open the sidebar
      // search-in-files panel instead, stealing the shortcut from the editor.
      //
      // Nothing is lost by dropping it: the Search view's cross-file REPLACE is a capability OF
      // that view, not a shortcut of its own. Ctrl/Cmd+Shift+F opens the view, and the view's own
      // chevron toggle (`search-toggle-replace`) expands the replace row from there.
      if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        e.stopPropagation()
        const st = useUIStore.getState()
        st.setSidebarOpen(true)
        st.setSidebarView('search')
        st.requestSearchFocus()
        return
      }
      // ⌘⇧E — the Files view, symmetric with ⌘⇧F above (VS Code `workbench.view.explorer`).
      // `requestPanelFocus` hands focus to the tree afterwards (WCAG 2.4.3); the app shell cannot
      // reach the panel element itself, so it bumps the nonce the Sidebar watches.
      if (mod && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault()
        e.stopPropagation()
        const st = useUIStore.getState()
        st.setSidebarOpen(true)
        st.setSidebarView('files')
        st.requestPanelFocus()
        return
      }
      // The formatting cluster: Ctrl/Cmd+B (Bold), +I (Italic), +K (Link), +E (Code),
      // +Shift+L (List), +Shift+T (Task) and +1..6 (Heading 1..6). Every one of them dispatches
      // the editor's existing `markdown:insert` event — the very same channel the toolbar's
      // buttons use — so there is exactly one implementation of "bold" / "italic" / "link" / ….
      //
      // `⌘B` REPLACED the old sidebar-toggle binding (the panel is folded by Ctrl/Cmd+\ only),
      // and the rest of the cluster was completed by ADR-0032.
      //
      //   - Deliberately renderer-only: the native menu carries NO accelerator for these keys, so
      //     there is exactly one handler and no double-fire.
      //   - Not VS Code bindings: there Ctrl+B toggles the BOTTOM panel, which MarkFlow does not
      //     have, so the key is free for the editor's primary inline action. Bold-on-⌘B is the
      //     convention of the Markdown-first editors (Typora / Obsidian / Bear / Zettlr), and the
      //     rest of the cluster follows the same editors (⌘I = italic, ⌘K = link, ⌘1..6 = heading).
      //   - Guarded by `isEditableTarget` so the key is NOT swallowed while the user types in ANY
      //     text field (sidebar search, a rename input, or the editor's own find & replace widget)
      //     — those surfaces keep the key for themselves.
      //   - The editor's own `markdown:insert` dispatcher ignores the event when read-only, so the
      //     shortcuts are no-ops in read-only mode — consistent with the disabled format buttons.
      //
      // The bindings and the glyphs the UI advertises live in ONE table
      // (lib/format-shortcuts.ts), so a tooltip can never drift from the key it promises.
      const format = matchFormatShortcut(e, isMac)
      if (format) {
        // The modal guard above already stood down for modal surfaces; only the focus check remains.
        if (isEditableTarget(document.activeElement)) return
        e.preventDefault()
        e.stopPropagation()
        document.dispatchEvent(
          new CustomEvent('markdown:insert', {
            detail: { before: format.before, after: format.after },
          }),
        )
        return
      }
    }
    // Capture phase: global shortcuts must fire even when the editor (CodeMirror) has focus and
    // would otherwise stopPropagation the keydown before it reaches a bubbling window listener.
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [setNewDocOpen, toggleSidebar])

  // Ctrl/Cmd+A that reaches the renderer (i.e. the native accelerator did not consume it)
  // would otherwise trigger the browser's document-wide select-all — both panes at once,
  // which CodeMirror then clamps into a bogus partial selection. Take it over at the document
  // level and route it to the pane the user is working in. Document-level on purpose: in
  // read-only mode the editor content cannot take focus, so the event's target is `body`.
  useEffect(() => {
    const onKeyDown = createSelectAllKeydownHandler()
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!window.api) return
    // R5 plan A: while the system print dialog is up, native menu events and drag-and-drop must
    // not mutate documents. The store guards switch/close themselves; these guards stop the
    // surfaces that bypass the store (and their "discard unsaved changes?" prompts).
    const blocked = (): boolean => useUIStore.getState().printing
    const removeNew = window.api.onMenuEvent('new-document', () => void createDraft())
    const removeNewFile = window.api.onMenuEvent('new-file', () => {
      if (blocked()) return
      setNewDocOpen(true)
    })
    const removeSidebar = window.api.onMenuEvent('toggle-sidebar', () => toggleSidebar())
    const removeSetTheme = window.api.onMenuEvent('set-theme', (data) => {
      // The native theme menu sends the raw choice as a plain string; narrow it to the store's
      // ThemeMode before recording it. The theme effect above bridges the value to nativeTheme and
      // to the menu's radio checkmark, so this handler only records the choice.
      if (data === 'light' || data === 'dark' || data === 'system') {
        useUIStore.getState().setTheme(data)
      }
    })
    const removeOpen = window.api.onMenuEvent('open-files', (data) => {
      if (blocked()) return
      const paths = Array.isArray(data) ? data : data ? [data as string] : []
      if (paths.length === 0) return
      void openPathsWithDecision(paths)
    })
    const removeClose = window.api.onMenuEvent('close-workspace', () => {
      tryCloseWorkspace(false)
    })
    const removeCloseFile = window.api.onMenuEvent('close-file', async () => {
      if (blocked()) return
      const st = useUIStore.getState()
      // When the export dialog is open, Cmd/Ctrl+W should close the dialog rather than the file.
      if (st.exportOpen) {
        st.setExportOpen(false)
        return
      }
      // While writing a file, fully ignore the close-file request so no path loses the workspace.
      if (st.exporting) return
      const tabs = useTabsStore.getState()
      const activeTabId = tabs.activeTabId
      const activeTab = tabs.tabs.find((tab) => tab.id === activeTabId)
      if (!activeTab) {
        st.closeDocument()
        return
      }
      if (st.isTabDirty(activeTab.documentId)) {
        const ok = await window.api.dialog.confirm({
          message: t('app.unsavedClose'),
          okText: t('app.confirmDiscard'),
          cancelText: t('app.confirmKeep'),
        })
        if (!ok) return
      }
      // ADR-0040: close just the active tab, preserving every other tab's draft.
      useUIStore.getState().closeTabDocument(activeTab.documentId, activeTab.isNewUnsaved)
      useTabsStore.getState().closeTab(activeTab.id)
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
    const removePrint = window.api.onMenuEvent('print', () => void printDocument())
    const removeSelectAll = window.api.onMenuEvent('select-all', () => routeSelectAll())
    const removeTogglePreview = window.api.onMenuEvent('toggle-preview', () =>
      useUIStore.getState().cycleViewMode(),
    )
    const removeOpenPaths = window.api.onOpenPaths((paths) => {
      if (blocked()) return
      if (paths && paths.length > 0) void openPathsWithDecision(paths)
    })
    // Another window (the "reuse existing window" branch) asked us to reveal one of our files.
    // Guarded because older test/preload mocks may not expose this newest event yet.
    const removeRevealFile = window.api.onRevealFile
      ? window.api.onRevealFile((filePath) => {
          if (blocked()) return
          void navigateToPath(filePath)
        })
      : () => {}
    return () => {
      removeRevealFile()
      removeNew()
      removeNewFile()
      removeSidebar()
      removeSetTheme()
      removeOpen()
      removeClose()
      removeCloseFile()
      removeOpenPaths()
      removeFileDetails()
      removeAbout()
      removeExport()
      removePrint()
      removeSelectAll()
      removeTogglePreview()
    }
  }, [
    setNewDocOpen,
    toggleSidebar,
    openPathsMut,
    closeWorkspace,
    tryCloseWorkspace,
    openPathsWithDecision,
  ])

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
        if (paths && paths.length > 0) void openPathsWithDecision(paths)
      })
      .catch(() => {})
  }, [openPathsWithDecision])

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

  // Sync "has an active folder" so the native File > New File… item is greyed out on the
  // welcome screen. Same source of truth as the sidebar's own + button visibility.
  useEffect(() => {
    if (!window.api?.menu?.setHasFolder) return
    const send = (has: boolean) => window.api.menu.setHasFolder(has)
    send(!!useUIStore.getState().workspaceRoot)
    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.workspaceRoot !== prev.workspaceRoot) send(!!state.workspaceRoot)
    })
    return () => unsub()
  }, [])

  // Sync "an unsaved draft already exists" so the native File > New Draft item greys out in
  // lockstep with the toolbar button and the editor's empty-state entry. Unlike the store-synced
  // flags above, this one is DERIVED from the document list, so it follows that query instead of a
  // store subscription — a dead menu item that still invited a second draft was the gap.
  useEffect(() => {
    if (!window.api?.menu?.setHasDraft) return
    window.api.menu.setHasDraft(draftExists)
  }, [draftExists])

  // ADR-0040: a cross-window drop / detached tab arrives here. Seed the tab with its
  // draft and history, then ACK so the source releases its own copy. A new window reads
  // the handoff from main directly (tabs:take-handoff) instead of this event.
  useEffect(() => {
    if (!window.api?.onTabAccept || !window.api?.tabs) return
    const remove = window.api.onTabAccept(({ token, handoff }) => {
      void acceptTabHandoff(handoff).then(() => window.api.tabs.acceptAck(token))
    })
    return () => remove()
  }, [])

  useEffect(() => {
    if (!window.api?.onTabRemove) return
    const remove = window.api.onTabRemove(({ tabId }) => removeTransferredTab(tabId))
    return () => remove()
  }, [])

  // A new window created by detach consumes its pending handoff once at startup.
  useEffect(() => {
    let cancelled = false
    void window.api?.tabs?.takeHandoff?.().then(async (pending) => {
      if (cancelled || !pending) return
      await acceptTabHandoff(pending.handoff)
      await window.api.tabs.acceptAck(pending.token)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Native menu / keyboard alternatives to dragging a tab.
  useEffect(() => {
    if (!window.api?.onMenuEvent) return
    const unsubs = [
      window.api.onMenuEvent('detach-tab-to-window', () => {
        const tabId = useTabsStore.getState().activeTabId
        if (!tabId) return
        void buildTabHandoff(tabId).then(async (handoff) => {
          if (!handoff) return
          const { token } = await window.api.tabs.beginDrag(handoff)
          await window.api.tabs.detach(token)
        })
      }),
      window.api.onMenuEvent('move-tab-to-window', () => {
        const tabId = useTabsStore.getState().activeTabId
        if (!tabId) return
        void buildTabHandoff(tabId).then(async (handoff) => {
          if (!handoff) return
          const windows = await window.api.tabs.listWindows()
          if (windows.length === 0) return
          const { token } = await window.api.tabs.beginDrag(handoff)
          await window.api.tabs.moveToWindow(token, windows[0].id)
        })
      }),
    ]
    return () => unsubs.forEach((unsub) => unsub())
  }, [])

  // When the main process requests THIS window to close, run the exact same "close workspace"
  // flow (with its unified unsaved-changes prompt). If the user confirms (or there's nothing to
  // save), tell the main process it may close that window; otherwise we simply don't reply and
  // the window stays open. New (memory-only) docs and edits to existing files are treated
  // identically — no special close prompt.
  useEffect(() => {
    if (!window.api?.onAppRequestQuit) return
    const remove = window.api.onAppRequestQuit(() => {
      if (tryCloseWorkspace(true)) window.api.app.allowQuit()
    })
    return () => remove()
  }, [tryCloseWorkspace])

  // When files are added/removed in the directory of an open document, refresh the sidebar
  // list. This does not prompt to reload the active document (that is onFileChanged's job)
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
      const active = useUIStore.getState().workspaceRoot
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
        // refetches every 'detail' entry including the active document, whose
        // refetch competes with the very switch/edit the renderer may be busy
        // with. Narrowing to the active folder's list keeps the sidebar current
        // without touching the open document.
        const active = useUIStore.getState().workspaceRoot
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

  // ONE document's identity changed outside the app: its file was deleted (the record is
  // kept and marked missing, so the document stays open and can be saved back) or renamed
  // (the record was re-pointed at the new path, keeping its id). Re-read just that
  // document's record so the title bar follows strike-through for a deleted file, the
  // new name for a renamed one.
  //
  // Scoped to a single 'detail' entry on purpose, and kept separate from the folder event
  // above: invalidating every detail costs a refetch of the open document, which competes
  // with the very switch/edit the renderer may be busy with (measured as intermittent lag,
  // which is why the folder handler deliberately narrows to the list).
  useEffect(() => {
    if (!window.api?.onDocumentRefresh) return
    return window.api.onDocumentRefresh((data) => {
      const id = data?.id
      if (!id) return
      queryClient.invalidateQueries({ queryKey: [...DOCS_KEY, 'detail', id] })
    })
  }, [])

  // Open files/folders dragged into the window (cross-platform)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      // No dirty guard here (Q30): the single guard point lives in the close path of each branch.
      // A workspace-external single Markdown goes through the four-way choice; everything else keeps
      // the normal useOpenPaths funnel, whose own guard fires only when it actually closes a doc.
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => window.api.files.getPathForFile(f))
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
      if (paths.length > 0) await openPathsWithDecision(paths)
    },
    [openPathsWithDecision],
  )

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
        {/* R5 plan A: NO standalone print preview window and NO overlay. The main window's own
            preview pane is what the user looks at while printing, so it must stay scrollable and
            hit-testable. The "no editing / no switching or closing files" rule is a fine-grained
            lock (editor read-only + store/menu guards), never a whole-window disable or a
            covering layer. StatusBar shows the non-blocking "Printing…" state. */}
      </div>
    </TooltipProvider>
  )
}
