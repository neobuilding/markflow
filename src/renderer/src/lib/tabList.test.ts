import { describe, expect, it, beforeEach } from 'vitest'
import {
  __resetTabIdsForTests,
  findTabByDocumentId,
  findTabIndexById,
  moveTabInList,
  neighbourAfterRemove,
  nextTabId,
  openTabInList,
  removeTabFromList,
  removeTabsFromList,
  replaceDocumentInList,
  updateTabInList,
  type Tab,
} from './tabList'

const tab = (id: string, documentId = `doc-${id}`): Tab => ({
  id,
  documentId,
  title: id,
  editable: false,
  isNewUnsaved: false,
  external: false,
})

describe('tabList pure operations (ADR-0040)', () => {
  beforeEach(() => __resetTabIdsForTests())

  it('generates increasing ids and resets them for tests', () => {
    expect(nextTabId()).toBe('tab-1')
    expect(nextTabId()).toBe('tab-2')
    __resetTabIdsForTests()
    expect(nextTabId()).toBe('tab-1')
  })

  it('finds tabs by id and by document id', () => {
    const tabs = [tab('a', 'doc-a'), tab('b', 'doc-b')]
    expect(findTabIndexById(tabs, 'b')).toBe(1)
    expect(findTabIndexById(tabs, 'missing')).toBe(-1)
    expect(findTabByDocumentId(tabs, 'doc-a')?.id).toBe('a')
    expect(findTabByDocumentId(tabs, 'nope')).toBeUndefined()
  })

  it('opens a new tab with defaults and supplied options', () => {
    const created = openTabInList([], 'doc-a')
    expect(created.tabId).toBe('tab-1')
    expect(created.tabs[0]).toEqual({
      id: 'tab-1',
      documentId: 'doc-a',
      title: '',
      editable: false,
      isNewUnsaved: false,
      external: false,
    })
    const supplied = openTabInList([], 'doc-b', {
      tabId: 'fixed',
      title: 'B.md',
      editable: true,
      isNewUnsaved: true,
    })
    expect(supplied.tabs[0]).toEqual({
      id: 'fixed',
      documentId: 'doc-b',
      title: 'B.md',
      editable: true,
      isNewUnsaved: true,
      external: false,
    })
  })

  it('reuses an existing tab for the same document id', () => {
    const tabs = [tab('a', 'doc-a')]
    const result = openTabInList(tabs, 'doc-a', { title: 'ignored' })
    expect(result.tabId).toBe('a')
    expect(result.tabs).toEqual(tabs)
    expect(result.tabs).not.toBe(tabs)
  })

  it('chooses right neighbour first, then left, then none', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(neighbourAfterRemove(tabs, 0)).toBe('b')
    expect(neighbourAfterRemove(tabs, 1)).toBe('c')
    expect(neighbourAfterRemove(tabs, 2)).toBe('b')
    expect(neighbourAfterRemove([], 0)).toBeNull()
    expect(neighbourAfterRemove(tabs, -1)).toBeNull()
    expect(neighbourAfterRemove(tabs, 9)).toBeNull()
    expect(neighbourAfterRemove([tab('only')], 0)).toBeNull()
  })

  it('removes one tab and reports the next active id', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const removed = removeTabFromList(tabs, 'b')
    expect(removed).toEqual({
      tabs: [tab('a'), tab('c')],
      removedIndex: 1,
      nextActiveId: 'c',
    })
    const missing = removeTabFromList(tabs, 'nope')
    expect(missing.removedIndex).toBe(-1)
    expect(missing.nextActiveId).toBeNull()
  })

  it('removes several tabs at once', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(removeTabsFromList(tabs, [])).toEqual(tabs)
    expect(removeTabsFromList(tabs, ['a', 'c']).map((t) => t.id)).toEqual(['b'])
  })

  it('reorders tabs, clamping and no-oping at the same index', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(moveTabInList(tabs, 'a', 2).map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(moveTabInList(tabs, 'c', 0).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    expect(moveTabInList(tabs, 'b', 1)).toEqual(tabs)
    expect(moveTabInList(tabs, 'a', 99).map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(moveTabInList(tabs, 'a', -5).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(moveTabInList(tabs, 'missing', 0)).toEqual(tabs)
  })

  it('replaces the document of one tab', () => {
    const tabs = [tab('a'), tab('b')]
    expect(replaceDocumentInList(tabs, 'a', 'new')).toEqual([
      { ...tab('a'), documentId: 'new' },
      tab('b'),
    ])
    expect(replaceDocumentInList(tabs, 'missing', 'new')).toEqual(tabs)
  })

  it('patches a tab without changing its identity', () => {
    const tabs = [tab('a'), tab('b')]
    expect(updateTabInList(tabs, 'a', { title: 'A', editable: true })).toEqual([
      { ...tab('a'), title: 'A', editable: true },
      tab('b'),
    ])
    expect(updateTabInList(tabs, 'missing', { title: 'X' })).toEqual(tabs)
  })
})
