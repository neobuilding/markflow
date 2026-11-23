import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  __resetTabHistoriesForTests,
  createHistory,
  currentHistory,
  disposeHistory,
  getHistory,
  pushTabHistory,
  seedHistory,
  useActiveTabHistory,
} from './tabHistory'
import { useNavigationHistory } from './navigationHistory'
import { useTabsStore } from './tabs'

describe('tabHistory — one global navigation stack (ADR-0042)', () => {
  beforeEach(() => {
    __resetTabHistoriesForTests()
    useNavigationHistory.getState().reset()
    useTabsStore.getState().reset()
  })

  it('resolves every tab id to the same global store', () => {
    const a = createHistory('a')
    const b = createHistory('b')
    expect(b).toBe(a)
    a.getState().push('/a.md')
    expect(useNavigationHistory.getState().entries[0]?.path).toBe('/a.md')
    expect(createHistory('a')).toBe(a)
  })

  it('seeds entries and cursor from a handoff', () => {
    const h = seedHistory('t', [{ path: '/a.md', openMode: 'in-place' }, { path: '/b.md' }], 1)
    expect(h.getState().entries).toHaveLength(2)
    expect(h.getState().cursor).toBe(1)
    expect(h.getState().entryAt(1)?.path).toBe('/b.md')
  })

  it('reports the global stack and treats disposeHistory as a no-op', () => {
    const h = createHistory('a')
    useTabsStore.getState().openTab('doc-a', { tabId: 'a' })
    expect(currentHistory()).toBe(h)
    disposeHistory('a')
    expect(getHistory('a')).toBe(h)
    expect(useNavigationHistory.getState().entries).toEqual([])
  })

  it('pushTabHistory records the tab id and ignores missing ids/paths', () => {
    pushTabHistory('a', '/a.md', { openMode: 'external-keep' })
    expect(useNavigationHistory.getState().entries[0]).toMatchObject({
      path: '/a.md',
      openMode: 'external-keep',
      tabId: 'a',
    })
    const before = useNavigationHistory.getState().entries.length
    pushTabHistory(null, '/x.md')
    pushTabHistory('b', null)
    expect(useNavigationHistory.getState().entries).toHaveLength(before)
  })

  it('useActiveTabHistory reads the global store regardless of tab switch', () => {
    useNavigationHistory.getState().push('/legacy.md')
    const { result, rerender } = renderHook(() => useActiveTabHistory((s) => s.entries))
    expect(result.current[0].path).toBe('/legacy.md')
    useTabsStore.getState().openTab('doc-a', { tabId: 'a' })
    useNavigationHistory.getState().push('/a.md')
    rerender()
    expect(result.current).toHaveLength(2)
    expect(result.current[1].path).toBe('/a.md')
  })
})
