import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUIStore } from './ui'

describe('useUIStore — all setters and toggles', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // reset to defaults between tests via a fresh state snapshot is overkill; just set known values
    const s = useUIStore.getState()
    s.setSidebarOpen(true)
    s.setActiveDocumentId(null)
    s.setActiveFolder(null)
    s.setEditable(false)
    s.setViewMode('split')
    s.setSearchOpen(false)
    s.setSearchQuery('')
    s.setTheme('light')
    s.setLanguage('en')
    s.setNewDocOpen(false)
    s.setAboutOpen(false)
    s.setDirty(false)
    s.setSaving(false)
    s.setPrinting(false)
    s.setJustSaved(false)
    s.setExternalChange(null)
    s.setFileDetailsId(null)
    s.setExportOpen(false)
    s.setExporting(false)
    s.setIsNewUnsaved(false)
  })

  it('toggleSidebar flips the flag', () => {
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })

  it('toggleEditable flips the flag', () => {
    useUIStore.getState().toggleEditable()
    expect(useUIStore.getState().editable).toBe(true)
  })

  it('simple setters update their slices', () => {
    useUIStore.getState().setActiveDocumentId('x')
    expect(useUIStore.getState().activeDocumentId).toBe('x')

    useUIStore.getState().setActiveFolder('/f')
    expect(useUIStore.getState().activeFolder).toBe('/f')

    useUIStore.getState().setViewMode('preview')
    expect(useUIStore.getState().viewMode).toBe('preview')

    useUIStore.getState().setSearchOpen(true)
    useUIStore.getState().setSearchQuery('q')
    expect(useUIStore.getState().searchOpen).toBe(true)
    expect(useUIStore.getState().searchQuery).toBe('q')

    useUIStore.getState().setTheme('dark')
    expect(useUIStore.getState().theme).toBe('dark')

    useUIStore.getState().setNewDocOpen(true)
    expect(useUIStore.getState().newDocOpen).toBe(true)

    useUIStore.getState().setAboutOpen(true)
    expect(useUIStore.getState().aboutOpen).toBe(true)

    useUIStore.getState().setDirty(true)
    expect(useUIStore.getState().dirty).toBe(true)

    useUIStore.getState().setSaving(true)
    useUIStore.getState().setPrinting(true)
    useUIStore.getState().setJustSaved(true)
    expect(useUIStore.getState().saving).toBe(true)
    expect(useUIStore.getState().printing).toBe(true)
    expect(useUIStore.getState().justSaved).toBe(true)

    useUIStore.getState().setExternalChange({ id: 'e', filePath: '/e' })
    expect(useUIStore.getState().externalChange).toEqual({ id: 'e', filePath: '/e' })
    useUIStore.getState().clearExternalChange()
    expect(useUIStore.getState().externalChange).toBeNull()

    useUIStore.getState().setFileDetailsId('fd')
    expect(useUIStore.getState().fileDetailsId).toBe('fd')

    useUIStore.getState().setExportOpen(true)
    useUIStore.getState().setExporting(true)
    expect(useUIStore.getState().exportOpen).toBe(true)
    expect(useUIStore.getState().exporting).toBe(true)

    useUIStore.getState().setIsNewUnsaved(true)
    expect(useUIStore.getState().isNewUnsaved).toBe(true)
  })

  it('setLanguage persists the choice', () => {
    useUIStore.getState().setLanguage('zh-CN')
    expect(useUIStore.getState().language).toBe('zh-CN')
  })

  it('closeWorkspace clears the active document and folder', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setActiveFolder('/f')
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().activeFolder).toBeNull()
  })

  it('closeWorkspace is blocked while exporting or the export dialog is open', () => {
    const s = useUIStore.getState()
    s.setActiveDocumentId('x')
    s.setExporting(true)
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBe('x')
    s.setExporting(false)
    s.setExportOpen(true)
    useUIStore.getState().closeWorkspace()
    expect(useUIStore.getState().activeDocumentId).toBe('x')
    s.setExportOpen(false)
  })

  it('closeWorkspace removes an unsaved memory-only draft via the api', async () => {
    ;(window as unknown as { api: { documents: { delete: ReturnType<typeof vi.fn> } } }).api = {
      documents: { delete: vi.fn().mockResolvedValue(true) },
    }
    const s = useUIStore.getState()
    s.setActiveDocumentId('draft-1')
    s.setIsNewUnsaved(true)
    useUIStore.getState().closeWorkspace()
    expect(window.api.documents.delete).toHaveBeenCalledWith('draft-1')
    // the draft flag is cleared
    expect(useUIStore.getState().isNewUnsaved).toBe(false)
  })
})
