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

describe('tabHistory — per-tab navigation stacks (ADR-0040)', () => {
  beforeEach(() => {
    __resetTabHistoriesForTests()
    useNavigationHistory.getState().reset()
    useTabsStore.getState().reset()
  })

  it('creates one isolated history per tab id', () => {
    const a = createHistory('a')
    const b = createHistory('b')
    a.getState().push('/a.md')
    expect(a.getState().entries).toEqual([{ path: '/a.md', title: undefined, openMode: undefined }])
    expect(b.getState().entries).toEqual([])
    expect(createHistory('a')).toBe(a)
  })

  it('seeds entries and cursor from a handoff', () => {
    const h = seedHistory('t', [{ path: '/a.md', openMode: 'in-place' }, { path: '/b.md' }], 1)
    expect(h.getState().entries).toHaveLength(2)
    expect(h.getState().cursor).toBe(1)
    expect(h.getState().entryAt(1)?.path).toBe('/b.md')
  })

  it('disposes a tab history and reports the active tab stack', () => {
    const h = createHistory('a')
    useTabsStore.getState().reset()
    expect(currentHistory()).toBeUndefined()
    useTabsStore.getState().openTab('doc-a', { tabId: 'a' })
    expect(currentHistory()).toBe(h)
    disposeHistory('a')
    expect(getHistory('a')).toBeUndefined()
  })

  it('pushTabHistory targets a specific tab and ignores missing ids/paths', () => {
    pushTabHistory('a', '/a.md', { openMode: 'external-keep' })
    expect(createHistory('a').getState().entries[0].openMode).toBe('external-keep')
    pushTabHistory(null, '/x.md')
    pushTabHistory('b', null)
    expect(getHistory('b')).toBeUndefined()
  })

  it('useActiveTabHistory re-renders on tab switch and falls back to the default store', () => {
    useNavigationHistory.getState().push('/legacy.md')
    const { result, rerender } = renderHook(() => useActiveTabHistory((s) => s.entries))
    expect(result.current[0].path).toBe('/legacy.md')
    useTabsStore.getState().openTab('doc-a', { tabId: 'a' })
    createHistory('a').getState().push('/a.md')
    rerender()
    expect(result.current[0].path).toBe('/a.md')
  })
})
