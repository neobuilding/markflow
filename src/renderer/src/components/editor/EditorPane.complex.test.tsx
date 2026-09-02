import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EditorView } from '@codemirror/view'
import { TooltipProvider } from '../ui/tooltip'
import { useUIStore } from '../../store/ui'
import { EditorPane } from './EditorPane'
import '../../i18n'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub MarkdownPreview (uses a Worker) so we only exercise the editor pane path.
vi.mock('../preview/MarkdownPreview', () => ({
  MarkdownPreview: () => <div data-testid="preview-stub" />,
}))

const docs: Record<
  string,
  {
    id: string
    title: string
    content: string
    filePath: string
    encoding: string
    updatedAt: number
    wordCount: number
  }
> = {
  a: {
    id: 'a',
    title: 'A',
    content: '# A content',
    filePath: '/a.md',
    encoding: 'utf-8',
    updatedAt: 1,
    wordCount: 1,
  },
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

interface ApiShape {
  documents: Record<string, ReturnType<typeof vi.fn>>
  export: Record<string, ReturnType<typeof vi.fn>>
  search: Record<string, ReturnType<typeof vi.fn>>
  app: Record<string, ReturnType<typeof vi.fn>>
  files: Record<string, ReturnType<typeof vi.fn>>
  dialog: Record<string, ReturnType<typeof vi.fn>>
  window: Record<string, ReturnType<typeof vi.fn>>
  menu: Record<string, ReturnType<typeof vi.fn>>
  clipboard: Record<string, ReturnType<typeof vi.fn>>
  onMenuEvent: ReturnType<typeof vi.fn>
  onFileChanged: ReturnType<typeof vi.fn>
  onFolderChanged: ReturnType<typeof vi.fn>
  onOpenPaths: ReturnType<typeof vi.fn>
  onAppRequestQuit: ReturnType<typeof vi.fn>
}

let api: ApiShape

// Wrap a store mutation in React act + a macrotask flush.
async function storeAct(fn: () => void): Promise<void> {
  const { act } = await import('react')
  act(fn)
  await flush()
}

beforeEach(() => {
  cleanup()
  const noopUnsub = () => {}
  api = {
    documents: {
      get: vi.fn(async (id: string) => docs[id] ?? null),
      setOpenFolder: vi.fn(async () => {}),
      clearOpenFolders: vi.fn(async () => {}),
      eol: vi.fn(async () => '\n'),
      update: vi.fn(async (id: string, u: { title?: string; content?: string }) => ({
        ...docs[id],
        ...u,
      })),
      list: vi.fn(async () => Object.values(docs)),
      create: vi.fn(async () => ({ ...docs.a, id: 'new' })),
      importMany: vi.fn(async (p: string[]) => p.map((x) => docs[x.replace('/', '')] ?? docs.a)),
      reload: vi.fn(async (id: string) => docs[id] ?? null),
      saveAs: vi.fn(async (id: string, fp: string, u: { title?: string; content?: string }) => ({
        ...docs[id],
        ...u,
        filePath: fp,
      })),
      setEncoding: vi.fn(async (id: string, e: string) => ({ ...docs[id], encoding: e })),
      delete: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ exists: true, size: 1, createdAt: 1, updatedAt: 1 })),
      import: vi.fn(async (fp: string) => docs[fp.replace('/', '')] ?? docs.a),
    },
    export: {
      embedImages: vi.fn(async (h: string) => h),
      write: vi.fn(async () => {}),
      print: vi.fn(async () => {}),
    },
    search: { query: vi.fn(async () => []) },
    app: {
      getTheme: vi.fn(async () => 'system' as const),
      setTheme: vi.fn(async () => {}),
      getVersion: vi.fn(async () => '0.0.0'),
      getInitialPaths: vi.fn(async () => []),
      showInFolder: vi.fn(async () => {}),
      setLanguage: vi.fn(),
      allowQuit: vi.fn(),
    },
    files: {
      resolvePaths: vi.fn(async (p: string[]) => ({ directories: ['/d'], markdownFiles: p })),
      getPathForFile: vi.fn((f: File) => f.name),
    },
    dialog: {
      openFiles: vi.fn(async () => []),
      openFolder: vi.fn(async () => null),
      openFolderPath: vi.fn(async () => null),
      saveFile: vi.fn(async () => null),
      saveHtmlFile: vi.fn(async () => null),
      confirm: vi.fn(async () => true),
    },
    window: {
      maximize: vi.fn(async () => {}),
      unmaximize: vi.fn(async () => {}),
      isMaximized: vi.fn(async () => false),
    },
    menu: { setEditable: vi.fn(), setHasDocument: vi.fn(), setPrinting: vi.fn() },
    clipboard: { writeText: vi.fn(async () => {}) },
    onMenuEvent: vi.fn(() => noopUnsub),
    onFileChanged: vi.fn(() => noopUnsub),
    onFolderChanged: vi.fn(() => noopUnsub),
    onOpenPaths: vi.fn(() => noopUnsub),
    onAppRequestQuit: vi.fn(() => noopUnsub),
  }
  ;(window as unknown as { api: ApiShape }).api = api
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  useUIStore.getState().setActiveDocumentId(null)
  useUIStore.getState().setEditable(false)
  useUIStore.getState().setActiveFolder(null)
  useUIStore.getState().setViewMode('edit')
  useUIStore.getState().setIsNewUnsaved(false)
  useUIStore.getState().setExternalChange(null)
  useUIStore.getState().setJustSaved(false)
  useUIStore.getState().setExportOpen(false)
  useUIStore.getState().setFileDetailsId(null)
  useUIStore.getState().setDirty(false)
})

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <EditorPane />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

async function openDoc(id = 'a'): Promise<void> {
  await storeAct(() => useUIStore.getState().setActiveDocumentId(id))
  // Wait until useDocument resolves and the per-document toolbar (save-btn) renders.
  await waitFor(() => screen.getByTestId('save-btn'))
}

async function setEditable(editable: boolean): Promise<void> {
  await storeAct(() => useUIStore.getState().setEditable(editable))
}

// Make the open document dirty. Prefer a real title-edit (so title-edit paths
// are exercised); if the title button is unavailable (e.g. a document rendered
// without a title), fall back to flipping the dirty flag directly. Both end with
// the document dirty so Save/Save-As become clickable.
async function makeDirty(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
): Promise<void> {
  // The document loads via React Query, so the title button only appears after
  // the doc resolves. Wait for it (it is always present for our fixtures, which
  // have a non-empty title) and exercise the real title-edit path.
  const titleBtn = await screen.findByTestId('title-btn')
  await user.click(titleBtn) // title button → edit mode
  await waitFor(() => expect(container.querySelector('input')).not.toBeNull())
  const input = container.querySelector('input') as HTMLInputElement
  await user.clear(input)
  await user.type(input, 'Renamed')
  await user.click(container) // blur → handleTitleSave marks dirty
  await flush()
}

describe('EditorPane — file operations (save / save-as / reload)', () => {
  it('Save writes the draft through update and marks just-saved', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)

    await user.click(screen.getByTestId('save-btn'))
    await waitFor(() => expect(api.documents.update).toHaveBeenCalled())
    expect(useUIStore.getState().justSaved).toBe(true)
    // Folder watching is owned by the main process and registered once when the folder
    // is opened; saving must not touch that registration.
    expect(api.documents.setOpenFolder).not.toHaveBeenCalled()
    expect(api.documents.clearOpenFolders).not.toHaveBeenCalled()
  })

  it('read-only mode disables the Save and Save-As buttons', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    // stay read-only
    const saveBtn = screen.getByTestId('save-btn') as HTMLButtonElement
    const saveAsBtn = screen.getByTestId('save-as-btn') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    expect(saveAsBtn.disabled).toBe(true)
    // clicking a disabled button is a no-op
    await user.click(saveBtn)
    await flush()
    expect(api.documents.update).not.toHaveBeenCalled()
  })

  it('Save As writes to a chosen path via saveAs', async () => {
    const user = userEvent.setup()
    api.dialog.saveFile = vi.fn(async () => '/chosen/new.md')
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)

    await user.click(screen.getByTestId('save-as-btn'))
    await waitFor(() =>
      expect(api.documents.saveAs).toHaveBeenCalledWith('a', '/chosen/new.md', expect.any(Object)),
    )
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
    expect(api.documents.eol).toHaveBeenCalledWith('/a.md')
  })

  it('Save As cancelled (null path) does nothing', async () => {
    const user = userEvent.setup()
    api.dialog.saveFile = vi.fn(async () => null)
    mount()
    await openDoc()
    await setEditable(true)

    await user.click(screen.getByTestId('save-as-btn'))
    await flush()
    expect(api.documents.saveAs).not.toHaveBeenCalled()
  })

  it('surfaces a save failure without crashing', async () => {
    const user = userEvent.setup()
    api.documents.update = vi.fn(async () => {
      throw new Error('disk full')
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)

    await user.click(screen.getByTestId('save-btn'))
    await waitFor(() => expect(alertSpy).toHaveBeenCalled())
    alertSpy.mockRestore()
  })

  it('shows file-gone alert when reload returns nothing', async () => {
    const user = userEvent.setup()
    api.documents.reload = vi.fn(async () => null)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    mount()
    await openDoc()

    await user.click(screen.getByTestId('reload-btn'))
    await waitFor(() => expect(alertSpy).toHaveBeenCalled())
    alertSpy.mockRestore()
  })

  it('surfaces a reload failure without crashing', async () => {
    const user = userEvent.setup()
    api.documents.reload = vi.fn(async () => {
      throw new Error('read error')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount()
    await openDoc()

    await user.click(screen.getByTestId('reload-btn'))
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('external-change dialog "reload" refreshes content and clears the change', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setExternalChange({ id: 'a', filePath: '/a.md' }))

    await user.click(screen.getByTestId('external-reload-btn'))
    await waitFor(() => expect(api.documents.reload).toHaveBeenCalledWith('a'))
    expect(useUIStore.getState().externalChange).toBeNull()
  })

  it('external-change dialog warns about unsaved edits when dirty', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    // Make a real title edit so the hook marks the document dirty (no debounce).
    await makeDirty(user, container)
    await storeAct(() => useUIStore.getState().setExternalChange({ id: 'a', filePath: '/a.md' }))
    // When dirty, the dialog renders the "discard your unsaved changes" copy.
    await waitFor(() => expect(screen.getByText(/discard|丢弃/i)).toBeInTheDocument())
  })

  it('external-change dialog "ignore" clears the prompt', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setExternalChange({ id: 'a', filePath: '/a.md' }))

    await user.click(screen.getByTestId('external-ignore-btn'))
    await flush()
    expect(useUIStore.getState().externalChange).toBeNull()
  })

  it('routes the first Save of a new document through Save As', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)
    await storeAct(() => useUIStore.getState().setIsNewUnsaved(true))

    await user.click(screen.getByTestId('save-btn'))
    // isNewUnsaved → handleSave() delegates to handleSaveAs() (which prompts for a path).
    await waitFor(() => expect(api.dialog.saveFile).toHaveBeenCalled())
    expect(api.documents.update).not.toHaveBeenCalled()
  })

  it('Save As does nothing when the save-file dialog throws', async () => {
    const user = userEvent.setup()
    api.dialog.saveFile = vi.fn(async () => {
      throw new Error('denied')
    })
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)
    await storeAct(() => useUIStore.getState().setIsNewUnsaved(true))

    await user.click(screen.getByTestId('save-btn'))
    await flush()
    expect(api.documents.saveAs).not.toHaveBeenCalled()
  })

  it('surfaces a Save As failure without crashing', async () => {
    const user = userEvent.setup()
    api.dialog.saveFile = vi.fn(async () => '/chosen/new.md')
    api.documents.saveAs = vi.fn(async () => {
      throw new Error('write error')
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)
    await storeAct(() => useUIStore.getState().setIsNewUnsaved(true))

    await user.click(screen.getByTestId('save-btn'))
    await waitFor(() => expect(alertSpy).toHaveBeenCalled())
    alertSpy.mockRestore()
  })

  it('falls back to the default line ending when eol read fails', async () => {
    const user = userEvent.setup()
    api.documents.eol = vi.fn(async () => {
      throw new Error('no eol')
    })
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)

    await user.click(screen.getByTestId('save-btn'))
    await waitFor(() => expect(api.documents.update).toHaveBeenCalled())
    // The on-disk line ending is read from the active document's path before saving.
    // This pins the true-branch of `doc?.filePath ? await eol(...) : getEol()`:
    // v8 reports line 102 (the `? await ...` arm) as having 0 hits even though this
    // call proves it executes — a line-attribution artifact of the transpiled
    // async/await ternary, not genuinely uncovered code.
    expect(api.documents.eol).toHaveBeenCalledWith('/a.md')
  })
})

describe('EditorPane — close & open', () => {
  it('Close with unsaved changes prompts confirm and keeps doc when cancelled', async () => {
    const user = userEvent.setup()
    api.dialog.confirm = vi.fn(async () => false)
    mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setDirty(true))
    expect(useUIStore.getState().dirty).toBe(true)

    await user.click(screen.getByTestId('close-btn'))
    await waitFor(() => expect(api.dialog.confirm).toHaveBeenCalled())
    expect(useUIStore.getState().activeDocumentId).toBe('a')
  })

  it('Close without unsaved changes closes immediately', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTestId('close-btn'))
    await flush()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('never registers an open folder itself (watching is main-process owned)', async () => {
    // The chokidar watcher lives in the main process and is told about opened
    // folders by useOpenPaths, not by the editor pane.
    mount()
    await openDoc()
    await flush()
    expect(api.documents.setOpenFolder).not.toHaveBeenCalled()
  })

  it('open-folder button hands the chosen path to the open-folder mutation', async () => {
    const user = userEvent.setup()
    // The open-folder button lives in the empty (no-document) state.
    mount()
    await flush()
    api.dialog.openFolderPath = vi.fn(async () => '/some/folder')
    await user.click(screen.getByTestId('open-folder-btn'))
    await waitFor(() => expect(api.dialog.openFolderPath).toHaveBeenCalled())
    // The chosen path is forwarded through useOpenFolder → useOpenPaths, which
    // resolves it and opens the enclosing directory.
    await waitFor(() => expect(api.documents.setOpenFolder).toHaveBeenCalledWith('/d'))
  })

  it('Close with unsaved changes and a confirmed discard closes the document', async () => {
    const user = userEvent.setup()
    api.dialog.confirm = vi.fn(async () => true)
    mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setDirty(true))
    await user.click(screen.getByTestId('close-btn'))
    await waitFor(() => expect(api.dialog.confirm).toHaveBeenCalled())
    await flush()
    // confirm() === true → handleClose proceeds past the `if (!ok) return` guard.
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('open-folder button is a no-op when the folder dialog is cancelled', async () => {
    const user = userEvent.setup()
    mount()
    await flush()
    api.dialog.openFolderPath = vi.fn(async () => null)
    await user.click(screen.getByTestId('open-folder-btn'))
    await waitFor(() => expect(api.dialog.openFolderPath).toHaveBeenCalled())
    await flush()
    // null path → the `if (folderPath)` guard skips the open-folder mutation.
    expect(api.documents.setOpenFolder).not.toHaveBeenCalled()
  })

  it('Close is cancelled when the unsaved-changes confirm is declined', async () => {
    const user = userEvent.setup()
    api.dialog.confirm = vi.fn(async () => false)
    mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setDirty(true))
    await user.click(screen.getByTestId('close-btn'))
    await waitFor(() => expect(api.dialog.confirm).toHaveBeenCalled())
    // Declining the confirm must NOT close the document.
    expect(useUIStore.getState().activeDocumentId).toBe('a')
  })

  it('Save As falls back to a default path when the document has no filePath', async () => {
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: '' }
    try {
      const user = userEvent.setup()
      const { container } = mount()
      api.dialog.saveFile = vi.fn(async () => '/default/a.md')
      await openDoc()
      await flush()
      await setEditable(true)
      await makeDirty(user, container)
      await user.click(screen.getByTestId('save-as-btn'))
      await waitFor(() =>
        // No filePath → Save As is used (default path resolves from the title).
        expect(api.dialog.saveFile).toHaveBeenCalled(),
      )
    } finally {
      docs.a = { ...docs.a, filePath: originalPath }
    }
  })

  it('Save As falls back to "Untitled" when the document title is blank', async () => {
    docs.blank = {
      id: 'blank',
      title: '',
      content: 'x',
      filePath: '/blank.md',
      encoding: 'utf-8',
      updatedAt: 0,
      wordCount: 1,
    }
    const user = userEvent.setup()
    try {
      api.dialog.saveFile = vi.fn(async () => '/default/blank.md')
      mount()
      await openDoc('blank')
      await flush()
      await storeAct(() => useUIStore.getState().setEditable(true))
      // Make a real content edit (title stays empty) so the hook marks the doc dirty
      // and Save As becomes enabled; this pins the `localTitle.trim() || 'Untitled'` arm.
      const cmEl = document.querySelector('.cm-editor') as HTMLElement
      const view = EditorView.findFromDOM(cmEl)
      expect(view).toBeTruthy()
      view!.dispatch({
        changes: { from: 0, to: view!.state.doc.length, insert: 'modified' },
      })
      await waitFor(() => expect(screen.getByTestId('save-as-btn')).not.toBeDisabled())
      await user.click(screen.getByTestId('save-as-btn'))
      await waitFor(() =>
        expect(api.documents.saveAs).toHaveBeenCalledWith(
          'blank',
          '/default/blank.md',
          expect.objectContaining({ title: 'Untitled' }),
        ),
      )
    } finally {
      delete docs.blank
    }
  })

  it('Save uses the default EOL when the document has no filePath', async () => {
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: '' }
    try {
      const user = userEvent.setup()
      const { container } = mount()
      api.dialog.saveFile = vi.fn(async () => '/default/a.md')
      await openDoc()
      await flush()
      await setEditable(true)
      await makeDirty(user, container)
      await user.click(screen.getByTestId('save-btn'))
      // No filePath (and not isNewUnsaved) → Save goes through update, not Save As.
      await waitFor(() => expect(api.documents.update).toHaveBeenCalled())
      expect(api.dialog.saveFile).not.toHaveBeenCalled()
      expect(api.documents.eol).not.toHaveBeenCalled()
    } finally {
      docs.a = { ...docs.a, filePath: originalPath }
    }
  })

  it('Save does nothing when the update returns no document', async () => {
    api.documents.update = vi.fn(async () => null)
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await flush()
    await setEditable(true)
    await makeDirty(user, container)
    // update() returns null → the `if (updated)` guard skips markSaved.
    await user.click(screen.getByTestId('save-btn'))
    await waitFor(() => expect(api.documents.update).toHaveBeenCalled())
    await flush()
    expect(api.dialog.saveFile).not.toHaveBeenCalled()
  })

  it('Reload does nothing when the reload returns no document', async () => {
    api.documents.reload = vi.fn(async () => null)
    let handler: (() => void) | undefined
    api.onMenuEvent = vi.fn((evt: string, h: () => void) => {
      if (evt === 'reload') handler = h
      return () => {}
    }) as unknown as typeof api.onMenuEvent
    mount()
    await openDoc()
    await flush()
    handler?.()
    await waitFor(() => expect(api.documents.reload).toHaveBeenCalled())
    // reload returns null → markSaved/setJustSaved is skipped (no "saved" state).
    await flush()
    expect(useUIStore.getState().justSaved).toBe(false)
  })

  it('menu "save" event triggers the same flow as the save button', async () => {
    const user = userEvent.setup()
    let handler: (() => void) | undefined
    api.onMenuEvent = vi.fn((evt: string, h: () => void) => {
      if (evt === 'save') handler = h
      return () => {}
    }) as unknown as typeof api.onMenuEvent
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)
    await storeAct(() => useUIStore.getState().setJustSaved(false))
    // The menu event fires the save flow without any click on the toolbar button.
    handler?.()
    await waitFor(() => expect(api.documents.update).toHaveBeenCalled())
    await flush()
    expect(useUIStore.getState().justSaved).toBe(true)
  })

  it('menu "save-as" event opens the save dialog and writes to the new path', async () => {
    const user = userEvent.setup()
    api.dialog.saveFile = vi.fn(async () => '/menu/target.md')
    let handler: (() => void) | undefined
    api.onMenuEvent = vi.fn((evt: string, h: () => void) => {
      if (evt === 'save-as') handler = h
      return () => {}
    }) as unknown as typeof api.onMenuEvent
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await makeDirty(user, container)
    // The menu event drives handleSaveAs: it asks for a path, then re-persists the draft.
    handler?.()
    await waitFor(() => expect(api.dialog.saveFile).toHaveBeenCalled())
    await waitFor(() => expect(api.documents.saveAs).toHaveBeenCalled())
  })

  it('Save falls back to "Untitled" when the document title is blank', async () => {
    // A document whose title is blank → on Save the empty title falls back to
    // "Untitled" (see handleSave: localTitle.trim() || 'Untitled').
    docs.blank = {
      id: 'blank',
      title: '',
      content: 'x',
      filePath: '/blank.md',
      encoding: 'utf-8',
      updatedAt: 0,
      wordCount: 1,
    }
    const user = userEvent.setup()
    try {
      mount()
      await openDoc('blank')
      await flush()
      await storeAct(() => useUIStore.getState().setEditable(true))
      // Make a real content edit (title stays empty) so the hook marks the doc
      // dirty and the Save button becomes enabled.
      const cmEl = document.querySelector('.cm-editor') as HTMLElement
      const view = EditorView.findFromDOM(cmEl)
      expect(view).toBeTruthy()
      view!.dispatch({
        changes: { from: 0, to: view!.state.doc.length, insert: 'modified' },
      })
      await waitFor(() => expect(screen.getByTestId('save-btn')).not.toBeDisabled())
      await storeAct(() => useUIStore.getState().setJustSaved(false))
      await user.click(screen.getByTestId('save-btn'))
      await waitFor(() =>
        expect(api.documents.update).toHaveBeenCalledWith(
          'blank',
          expect.objectContaining({ title: 'Untitled', content: 'modified' }),
        ),
      )
    } finally {
      delete docs.blank
    }
  })

  it('opens files picked from the open-file dialog', async () => {
    const user = userEvent.setup()
    api.dialog.openFiles = vi.fn(async () => ['/picked/a.md'])
    api.documents.importMany = vi.fn(async () => [
      { id: 'picked', title: 'A', content: '', filePath: '/picked/a.md' },
    ])
    mount()
    // With no document open, the empty-state panel shows the Open File / Open Folder buttons.
    await user.click(screen.getByRole('button', { name: /open file/i }))
    await waitFor(() => expect(api.files.resolvePaths).toHaveBeenCalledWith(['/picked/a.md']))
  })

  it('opens a folder picked from the open-folder dialog', async () => {
    const user = userEvent.setup()
    api.dialog.openFolderPath = vi.fn(async () => '/picked/folder')
    api.documents.importMany = vi.fn(async () => [
      { id: 'picked', title: 'A', content: '', filePath: '/picked/folder/a.md' },
    ])
    mount()
    await user.click(screen.getByRole('button', { name: /open folder/i }))
    await waitFor(() => expect(api.files.resolvePaths).toHaveBeenCalledWith(['/picked/folder']))
  })

  it('open-file dialog returning no files is a no-op', async () => {
    // beforeEach leaves openFiles() => [] and no active doc → empty-state Open File button.
    mount()
    const openBtn = await screen.findByRole('button', { name: /open file/i })
    await userEvent.click(openBtn)
    await waitFor(() => expect(api.files.resolvePaths).not.toHaveBeenCalled())
  })
})

describe('EditorPane — view mode, title edit, formatting & dialogs', () => {
  it('switches view mode between edit / split / preview', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTestId('view-split'))
    expect(useUIStore.getState().viewMode).toBe('split')
    await user.click(screen.getByTestId('view-preview'))
    expect(useUIStore.getState().viewMode).toBe('preview')
    await user.click(screen.getByTestId('view-edit'))
    expect(useUIStore.getState().viewMode).toBe('edit')
  })

  it('edits the title and saves it on blur (marks dirty)', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await flush()

    await user.click(screen.getByText('A'))
    await waitFor(() => expect(container.querySelector('input')).not.toBeNull())
    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.click(container) // blur
    await flush()
    expect(useUIStore.getState().dirty).toBe(true)
  })

  it('clicking a formatting button dispatches a markdown:insert event', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await setEditable(true)
    await flush()

    const boldBtn = screen.getByTestId('fmt-**-**')
    const listener = vi.fn()
    document.addEventListener('markdown:insert', listener)
    await user.click(boldBtn)
    await flush()
    expect(listener).toHaveBeenCalled()
    expect(listener.mock.calls[0][0].detail).toEqual({ before: '**', after: '**' })
    document.removeEventListener('markdown:insert', listener)
  })

  it('opens the file-details dialog', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTestId('file-details-btn'))
    await flush()
    expect(useUIStore.getState().fileDetailsId).toBe('a')
  })

  it('opens the export dialog', async () => {
    const user = userEvent.setup()
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTestId('export-btn'))
    await flush()
    expect(useUIStore.getState().exportOpen).toBe(true)
  })

  it('toggles the sidebar open via the toolbar button when it is closed', async () => {
    const user = userEvent.setup()
    useUIStore.getState().setSidebarOpen(false)
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTestId('sidebar-toggle-btn'))
    await flush()
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })
})

describe('EditorPane — split-view drag', () => {
  it('dragging the divider does not throw', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setViewMode('split'))
    await flush()

    const divider = container.querySelector('.group\\/divider') as HTMLElement
    expect(divider).toBeTruthy()

    await user.pointer({ keys: '[MouseLeft>]', target: divider })
    await user.pointer({ coords: { x: 400, y: 300 } })
    await user.pointer({ keys: '[/MouseLeft]' })
    await flush()
    expect(useUIStore.getState().viewMode).toBe('split')
  })
})

describe('EditorPane — title editing & breadcrumb & external dialog', () => {
  it('commits the title on Enter and marks dirty', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await flush()

    await user.click(screen.getByText('A'))
    await waitFor(() => expect(container.querySelector('input')).not.toBeNull())
    const input = container.querySelector('input') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.keyboard('{Enter}')
    await flush()
    expect(useUIStore.getState().dirty).toBe(true)
  })

  it('cancels the title edit on Escape (reverts to the original title)', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    await openDoc()
    await setEditable(true)
    await flush()

    await user.click(screen.getByText('A'))
    await waitFor(() => expect(container.querySelector('input')).not.toBeNull())
    const input = container.querySelector('input') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'Renamed')
    await user.keyboard('{Escape}')
    await flush()
    // original title button is shown again, no dirty flag
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('opens the file location from the breadcrumb', async () => {
    const showInFolder = vi.fn()
    const prevApi = (window as unknown as { api: ApiShape }).api
    ;(window as unknown as { api: ApiShape }).api = {
      ...prevApi,
      app: { ...prevApi.app, showInFolder, getTheme: vi.fn(), setTheme: vi.fn() },
    }
    mount()
    await openDoc()
    await flush()

    await userEvent.click(screen.getByTitle(/show in folder/i))
    expect(showInFolder).toHaveBeenCalledWith('/a.md')
  })

  it('copies the full file path from the breadcrumb menu', async () => {
    const user = userEvent.setup()
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: '/docs/sub/a.md' }
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTitle('Copy path'))
    const copyFull = await screen.findByText('Copy full path')
    await user.click(copyFull)
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('/docs/sub/a.md'))
    docs.a = { ...docs.a, filePath: originalPath }
  })

  it('copies just the file name from the breadcrumb menu', async () => {
    const user = userEvent.setup()
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: '/docs/sub/a.md' }
    mount()
    await openDoc()
    await flush()

    await user.click(screen.getByTitle('Copy path'))
    const copyName = await screen.findByText('Copy file name')
    await user.click(copyName)
    await waitFor(() => expect(api.clipboard.writeText).toHaveBeenCalledWith('a.md'))
    docs.a = { ...docs.a, filePath: originalPath }
  })

  it('navigates the sidebar to a directory segment clicked in the breadcrumb', async () => {
    const user = userEvent.setup()
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: '/docs/sub/a.md' }
    mount()
    await openDoc()
    await flush()

    // The breadcrumb renders clickable folder segments ("docs", "sub") plus the file name.
    const segments = screen.getAllByTitle('Go to this folder')
    expect(segments.length).toBeGreaterThan(0)
    await user.click(segments[0])
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('/docs'))
    docs.a = { ...docs.a, filePath: originalPath }
  })

  it('navigates to the correct Windows drive path segments in the breadcrumb', async () => {
    const user = userEvent.setup()
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: 'D:/GitHub/markflow/QUICKSTART.md' }
    mount()
    await openDoc()
    await flush()

    const segments = screen.getAllByTitle('Go to this folder')
    expect(segments).toHaveLength(3)

    await user.click(segments[0])
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('D:/'))

    await user.click(segments[1])
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('D:/GitHub'))

    await user.click(segments[2])
    await waitFor(() => expect(useUIStore.getState().activeFolder).toBe('D:/GitHub/markflow'))

    docs.a = { ...docs.a, filePath: originalPath }
  })

  it('does not write to clipboard when the document has no filePath (copy path early-returns)', async () => {
    const user = userEvent.setup()
    const originalPath = docs.a.filePath
    docs.a = { ...docs.a, filePath: '' }
    mount()
    await openDoc()
    await flush()

    // The Copy-path button is always rendered, but handleCopyPath returns early
    // when doc.filePath is empty, so the clipboard must not be touched.
    await user.click(screen.getByTitle('Copy path'))
    const copyFull = await screen.findByText('Copy full path')
    await user.click(copyFull)
    expect(api.clipboard.writeText).not.toHaveBeenCalled()
    docs.a = { ...docs.a, filePath: originalPath }
  })

  it('dismisses the external-change dialog when closed via onOpenChange', async () => {
    mount()
    await openDoc()
    await storeAct(() => useUIStore.getState().setExternalChange({ id: 'a', filePath: '/a.md' }))
    // Escape fires the Dialog's onOpenChange(false), which clears the external change.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(useUIStore.getState().externalChange).toBeNull())
  })

  it('shows the not-found screen when the document is missing', async () => {
    mount()
    await storeAct(() => useUIStore.getState().setActiveDocumentId('ghost'))
    // documents.get('ghost') resolves to null in the stub → editor shows "not found".
    await waitFor(() => expect(screen.getByText(/not ?found/i)).toBeInTheDocument())
  })

  it('registers the on-file-changed handler and sets the external change', async () => {
    let cb: ((data: { id: string; filePath: string }) => void) | null = null
    api.onFileChanged = vi.fn((handler) => {
      cb = handler
      return () => {}
    }) as unknown as ApiShape['onFileChanged']
    mount()
    await openDoc()
    expect(cb).not.toBeNull()
    // Simulate the main process reporting the file changed on disk.
    act(() => cb!({ id: 'a', filePath: '/a.md' }))
    expect(useUIStore.getState().externalChange).toEqual({ id: 'a', filePath: '/a.md' })
  })

  it("ignores on-file-changed events for a document that isn't currently active", async () => {
    // The main-process watcher reports every changed file in an opened folder,
    // not just the one the renderer is looking at. The pane must only flag the
    // change for the active document; other ids must be dropped so the user
    // never gets a "file changed on disk" dialog for the wrong file.
    let cb: ((data: { id: string; filePath: string }) => void) | null = null
    api.onFileChanged = vi.fn((handler) => {
      cb = handler
      return () => {}
    }) as unknown as ApiShape['onFileChanged']
    mount()
    await openDoc() // active = 'a'
    expect(cb).not.toBeNull()
    // A change to a different document id should be silently ignored.
    act(() => cb!({ id: 'other-doc', filePath: '/other.md' }))
    expect(useUIStore.getState().externalChange).toBeNull()
    // The active-document branch still works after a non-matching event.
    act(() => cb!({ id: 'a', filePath: '/a.md' }))
    expect(useUIStore.getState().externalChange).toEqual({ id: 'a', filePath: '/a.md' })
  })
})
