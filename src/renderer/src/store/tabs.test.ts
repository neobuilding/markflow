import { beforeEach, describe, expect, it } from 'vitest'
import { __resetTabIdsForTests } from '../lib/tabList'
import { useTabsStore } from './tabs'
import { useUIStore } from './ui'

describe('tabs store (ADR-0040)', () => {
  beforeEach(() => {
    __resetTabIdsForTests()
    useTabsStore.getState().reset()
    useUIStore.setState({
      activeDocumentId: null,
      activeDocumentTitle: null,
      editable: false,
      isNewUnsaved: false,
      dirty: false,
      unsavedBuffers: {},
    })
  })

  it('opens a tab and mirrors the active document into the UI store', () => {
    const id = useTabsStore.getState().openTab('doc-1', { title: 'one.md', editable: true })
    expect(useTabsStore.getState().tabs).toEqual([
      {
        id,
        documentId: 'doc-1',
        title: 'one.md',
        editable: true,
        isNewUnsaved: false,
        external: false,
      },
    ])
    expect(useTabsStore.getState().activeTabId).toBe(id)
    expect(useUIStore.getState().activeDocumentId).toBe('doc-1')
    expect(useUIStore.getState().activeDocumentTitle).toBe('one.md')
    expect(useUIStore.getState().editable).toBe(true)
    expect(useUIStore.getState().dirty).toBe(false)
  })

  it('reuses an existing tab for the same document and can open without activating', () => {
    const first = useTabsStore.getState().openTab('doc-1')
    const again = useTabsStore.getState().openTab('doc-1')
    expect(again).toBe(first)
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    const second = useTabsStore.getState().openTab('doc-2', {
      activate: false,
      tabId: 'handoff-tab',
    })
    expect(second).toBe('handoff-tab')
    expect(useTabsStore.getState().activeTabId).toBe(first)
  })

  it('openTabWithId reuses by document and patches an existing tab', () => {
    const first = useTabsStore.getState().openTabWithId('fixed', 'doc-1', { title: 'A.md' })
    expect(first).toBe('fixed')
    expect(useTabsStore.getState().openTabWithId('other', 'doc-1', { title: 'renamed.md' })).toBe(
      'fixed',
    )
    expect(useTabsStore.getState().tabs[0].title).toBe('renamed.md')
  })

  it('activateTab ignores unknown ids and restores dirty from the buffer registry', () => {
    useTabsStore.getState().openTab('doc-1', { title: 'A.md', tabId: 'a' })
    useTabsStore.getState().openTab('doc-2', { title: 'B.md', tabId: 'b' })
    useUIStore.getState().reportUnsavedBuffer('doc-2', 'draft', 'B*.md')
    useTabsStore.getState().activateTab('b')
    expect(useUIStore.getState().dirty).toBe(true)
    expect(useUIStore.getState().activeDocumentTitle).toBe('B.md')
    useTabsStore.getState().activateTab('missing')
    expect(useTabsStore.getState().activeTabId).toBe('b')
  })

  it('activateTab mirrors dirty from an existing buffer into a tab created later', () => {
    useUIStore.getState().reportUnsavedBuffer('doc-1', 'draft', 'A*.md')
    const id = useTabsStore.getState().openTab('doc-1')
    expect(useUIStore.getState().dirty).toBe(true)
    expect(id).toBeTruthy()
  })

  it('closeTab activates the right neighbour, then the left, then clears mirrors', () => {
    const a = useTabsStore.getState().openTabWithId('a', 'doc-a')
    useTabsStore.getState().openTabWithId('b', 'doc-b')
    useTabsStore.getState().openTabWithId('c', 'doc-c')
    useTabsStore.getState().activateTab(a)
    useTabsStore.getState().closeTab('a')
    expect(useTabsStore.getState().activeTabId).toBe('b')
    expect(useUIStore.getState().activeDocumentId).toBe('doc-b')
    useTabsStore.getState().closeTab('c')
    expect(useTabsStore.getState().activeTabId).toBe('b')
    useTabsStore.getState().closeTab('b')
    expect(useTabsStore.getState().activeTabId).toBeNull()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
    expect(useUIStore.getState().dirty).toBe(false)
    // Closing an unknown tab is a no-op.
    useTabsStore.getState().closeTab('b')
    expect(useTabsStore.getState().tabs).toEqual([])
  })

  it('openTabWithId can open without activating', () => {
    const id = useTabsStore.getState().openTabWithId('fixed', 'doc-a', { activate: false })
    expect(id).toBe('fixed')
    expect(useTabsStore.getState().activeTabId).toBeNull()
  })

  it('closeTab of a background tab keeps the active tab unchanged', () => {
    useTabsStore.getState().openTabWithId('a', 'doc-a')
    useTabsStore.getState().openTabWithId('b', 'doc-b')
    useTabsStore.getState().activateTab('b')
    useTabsStore.getState().closeTab('a')
    expect(useTabsStore.getState().activeTabId).toBe('b')
    expect(useUIStore.getState().activeDocumentId).toBe('doc-b')
  })

  it('replaceDocument keeps the tab id and refreshes the active mirror', () => {
    useTabsStore.getState().openTabWithId('a', 'doc-a')
    useTabsStore.getState().replaceDocument('a', 'doc-new')
    expect(useTabsStore.getState().tabs[0].documentId).toBe('doc-new')
    expect(useUIStore.getState().activeDocumentId).toBe('doc-new')
    useTabsStore.getState().replaceDocument('missing', 'doc-x')
    expect(useUIStore.getState().activeDocumentId).toBe('doc-new')
  })

  it('moveTab reorders and removeTabs clears the active tab when included', () => {
    useTabsStore.getState().openTabWithId('a', 'doc-a')
    useTabsStore.getState().openTabWithId('b', 'doc-b')
    useTabsStore.getState().activateTab('a')
    useTabsStore.getState().moveTab('b', 0)
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual(['b', 'a'])
    useTabsStore.getState().removeTabs(['a'])
    expect(useTabsStore.getState().activeTabId).toBeNull()
    expect(useUIStore.getState().activeDocumentId).toBeNull()
  })

  it('removeTabs without the active tab preserves activation', () => {
    useTabsStore.getState().openTabWithId('a', 'doc-a')
    useTabsStore.getState().openTabWithId('b', 'doc-b')
    useTabsStore.getState().activateTab('b')
    useTabsStore.getState().removeTabs([])
    useTabsStore.getState().removeTabs(['a'])
    expect(useTabsStore.getState().activeTabId).toBe('b')
  })

  it('updateTab patches a tab and refreshes the active mirror', () => {
    const id = useTabsStore.getState().openTab('doc-1')
    useTabsStore.getState().updateTab(id, { title: 'renamed.md', editable: true })
    expect(useUIStore.getState().activeDocumentTitle).toBe('renamed.md')
    expect(useUIStore.getState().editable).toBe(true)
    useTabsStore.getState().updateTab('missing', { title: 'X' })
    expect(useUIStore.getState().activeDocumentTitle).toBe('renamed.md')
  })

  describe('ADR-0041 preview slot', () => {
    it('replaces a clean preview and disposes its draft and history', async () => {
      const { createHistory, getHistory, __resetTabHistoriesForTests } =
        await import('./tabHistory')
      __resetTabHistoriesForTests()
      const store = useTabsStore.getState()
      const first = store.openTab('doc-a', { tabId: 'a', preview: true })
      createHistory('a').getState().push('/a.md')
      // Install then clear a buffer without the dirty pin trigger, simulating a save that left
      // the entry behind; replacement must still clean it up.
      useUIStore.setState({ unsavedBuffers: { 'doc-a': { content: '', title: '', revision: 1 } } })
      useUIStore.setState({ unsavedBuffers: {} })
      const second = store.openTab('doc-b', { tabId: 'b', preview: true })
      expect(useTabsStore.getState().previewTabId).toBe(second)
      expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([second])
      // ADR-0042: no per-tab stack to dispose; both ids resolve to the same global stack.
      expect(getHistory(first)).toBe(getHistory(second))
    })

    it('pins an unexpectedly dirty preview instead of discarding it', () => {
      const store = useTabsStore.getState()
      store.openTab('doc-a', { tabId: 'a', preview: true })
      // Bypass reportUnsavedBuffer so the pin trigger is not exercised: this is the safety path.
      useUIStore.setState({ unsavedBuffers: { 'doc-a': { content: 'd', title: '', revision: 1 } } })
      const second = store.openTab('doc-b', { tabId: 'b', preview: true })
      expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a', second])
      expect(useTabsStore.getState().previewTabId).toBe(second)
      expect(useUIStore.getState().unsavedBuffers['doc-a']?.content).toBe('d')
    })

    it('pins a preview on the first dirty report and ignores later reports', () => {
      const store = useTabsStore.getState()
      const id = store.openTab('doc-a', { tabId: 'a', preview: true })
      expect(useTabsStore.getState().previewTabId).toBe(id)
      useUIStore.getState().reportUnsavedBuffer('doc-a', 'draft', 'A.md')
      expect(useTabsStore.getState().previewTabId).toBeNull()
      useUIStore.getState().reportUnsavedBuffer('doc-a', 'draft 2', 'A.md')
      expect(useTabsStore.getState().previewTabId).toBeNull()
    })

    it('activates existing tabs without moving the preview slot', () => {
      const store = useTabsStore.getState()
      const preview = store.openTab('doc-a', { tabId: 'a', preview: true })
      const pinned = store.openTab('doc-b', { tabId: 'b' })
      store.openTab('doc-a', { preview: true })
      expect(useTabsStore.getState().previewTabId).toBe(preview)
      store.openTab('doc-b', { preview: true })
      expect(useTabsStore.getState().previewTabId).toBe(preview)
      expect(useTabsStore.getState().activeTabId).toBe(pinned)
      store.openTab('doc-a', { preview: false })
      expect(useTabsStore.getState().previewTabId).toBeNull()
    })

    it('pins the moved tab and clears the slot on close/remove/reset', () => {
      const store = useTabsStore.getState()
      const a = store.openTab('doc-a', { tabId: 'a', preview: true })
      const b = store.openTab('doc-b', { tabId: 'b' })
      store.moveTab(a, 1)
      expect(useTabsStore.getState().previewTabId).toBeNull()
      useTabsStore.setState({ previewTabId: b })
      store.closeTab(b)
      expect(useTabsStore.getState().previewTabId).toBeNull()
      useTabsStore.setState({ previewTabId: a })
      store.removeTabs([a])
      expect(useTabsStore.getState().previewTabId).toBeNull()
      useTabsStore.setState({ previewTabId: a })
      store.reset()
      expect(useTabsStore.getState().previewTabId).toBeNull()
    })

    it('keeps a handoff tab pinned even when its tab id already exists', () => {
      const store = useTabsStore.getState()
      const id = store.openTab('doc-a', { tabId: 'a', preview: true })
      store.openTabWithId('a', 'doc-a', { title: 'A.md', preview: false })
      expect(useTabsStore.getState().previewTabId).toBeNull()
      expect(useTabsStore.getState().tabs[0].title).toBe('A.md')
      expect(useTabsStore.getState().tabs[0].id).toBe(id)
    })

    it('pins the current preview on setDirty(true)', () => {
      const id = useTabsStore.getState().openTab('doc-a', { tabId: 'a', preview: true })
      useUIStore.setState({ activeDocumentId: 'doc-a' })
      useUIStore.getState().setDirty(true)
      expect(useTabsStore.getState().previewTabId).not.toBe(id)
    })

    it('does not activate an existing tab when activate is false', () => {
      const store = useTabsStore.getState()
      const first = store.openTab('doc-a', { tabId: 'a' })
      const second = store.openTab('doc-b', { tabId: 'b' })
      expect(useTabsStore.getState().activeTabId).toBe(second)
      expect(store.openTab('doc-a', { activate: false })).toBe(first)
      expect(useTabsStore.getState().activeTabId).toBe(second)
    })

    it('tolerates a stale preview slot without discarding any tab', () => {
      const store = useTabsStore.getState()
      const pinned = store.openTab('doc-a', { tabId: 'a' })
      useTabsStore.setState({ previewTabId: 'missing' })
      const preview = store.openTab('doc-b', { tabId: 'b', preview: true })
      expect(useTabsStore.getState().previewTabId).toBe(preview)
      expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([pinned, preview])
    })

    it('never opens a tab with an existing dirty buffer as preview', () => {
      useUIStore.setState({
        unsavedBuffers: { 'doc-dirty': { content: 'draft', title: '', revision: 1 } },
      })
      const id = useTabsStore.getState().openTab('doc-dirty', { tabId: 'dirty', preview: true })
      expect(useTabsStore.getState().previewTabId).toBeNull()
      expect(useTabsStore.getState().tabs[0].id).toBe(id)
    })

    it('pinTabByDocumentId ignores a different document', () => {
      const id = useTabsStore.getState().openTab('doc-a', { tabId: 'a', preview: true })
      useTabsStore.getState().pinTabByDocumentId('other')
      expect(useTabsStore.getState().previewTabId).toBe(id)
    })
  })
})
