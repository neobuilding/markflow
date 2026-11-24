import { beforeEach, describe, expect, it } from 'vitest'
import {
  createNavigationHistory,
  isHistoryRecordingSuspended,
  useNavigationHistory,
  withoutHistoryRecording,
} from './navigationHistory'

describe('navigationHistory', () => {
  beforeEach(() => useNavigationHistory.getState().reset())

  it('records path-keyed entries and moves the cursor with browser semantics', () => {
    const h = useNavigationHistory.getState()
    h.push('C:/a.md')
    h.push('C:/b.md')
    h.push('C:/a.md')
    expect(useNavigationHistory.getState().entries.map((e) => e.path)).toEqual([
      'C:/a.md',
      'C:/b.md',
      'C:/a.md',
    ])
    expect(useNavigationHistory.getState().cursor).toBe(2)
  })

  it('stores optional title and openMode on each entry', () => {
    useNavigationHistory.getState().push('/docs/a.md', { title: 'A', openMode: 'external-keep' })
    const entry = useNavigationHistory.getState().entryAt(0)
    expect(entry).toEqual({ path: '/docs/a.md', title: 'A', openMode: 'external-keep' })
    expect(useNavigationHistory.getState().entryAt(1)).toBeNull()
  })

  it('ignores empty paths and repeated activation of the current file', () => {
    const h = useNavigationHistory.getState()
    h.push(null)
    h.push(undefined)
    h.push('')
    h.push('/a.md')
    h.push('/A.MD')
    expect(useNavigationHistory.getState().entries.map((e) => e.path)).toEqual(['/a.md'])
  })

  it('truncates the forward part on a new navigation', () => {
    const h = useNavigationHistory.getState()
    h.push('/a.md')
    h.push('/b.md')
    h.push('/c.md')
    useNavigationHistory.getState().setCursor(0)
    h.push('/d.md')
    expect(useNavigationHistory.getState().entries.map((e) => e.path)).toEqual(['/a.md', '/d.md'])
    expect(useNavigationHistory.getState().cursor).toBe(1)
  })

  it('reports previous/next only at valid positions', () => {
    const h = useNavigationHistory.getState()
    expect(h.previous()).toBeNull()
    expect(h.next()).toBeNull()
    h.push('/a.md')
    h.push('/b.md')
    expect(useNavigationHistory.getState().previous()).toBe('/a.md')
    useNavigationHistory.getState().setCursor(0)
    expect(useNavigationHistory.getState().next()).toBe('/b.md')
  })

  it('returns null when a cursor-adjacent entry is missing', () => {
    const h = useNavigationHistory.getState()
    h.push('/a.md')
    useNavigationHistory.setState({
      cursor: 0,
      entries: [{ path: '/a.md' }, { path: '/b.md' }],
    })
    // entries[cursor + 1] can be absent only after an external prune/corruption; never throw.
    useNavigationHistory.setState({ entries: [{ path: '/a.md' }] })
    expect(useNavigationHistory.getState().next()).toBeNull()
    // In-range cursor but a hole at cursor + 1: the fallback must not throw.
    useNavigationHistory.setState({
      cursor: 0,
      entries: [{ path: '/a.md' }, undefined as unknown as { path: string }],
    })
    expect(useNavigationHistory.getState().next()).toBeNull()
    useNavigationHistory.setState({ cursor: 2, entries: [{ path: '/a.md' }] })
    expect(useNavigationHistory.getState().previous()).toBeNull()
  })

  it('clamps cursor moves and pruning', () => {
    const h = useNavigationHistory.getState()
    h.push('/a.md')
    h.push('/b.md')
    useNavigationHistory.getState().move(-1)
    useNavigationHistory.getState().move(-1)
    expect(useNavigationHistory.getState().cursor).toBe(0)
    useNavigationHistory.getState().move(1)
    useNavigationHistory.getState().move(1)
    useNavigationHistory.getState().move(1)
    expect(useNavigationHistory.getState().cursor).toBe(1)
    useNavigationHistory.getState().prune('/a.md')
    useNavigationHistory.getState().prune('/missing.md')
    expect(useNavigationHistory.getState().entries.map((e) => e.path)).toEqual(['/b.md'])
    expect(useNavigationHistory.getState().cursor).toBe(0)
  })

  it('suppresses automatic recording while a history move activates a document', async () => {
    const { withoutHistoryRecording, isHistoryRecordingSuspended } =
      await import('./navigationHistory')
    expect(isHistoryRecordingSuspended()).toBe(false)
    await expect(withoutHistoryRecording(async () => isHistoryRecordingSuspended())).resolves.toBe(
      true,
    )
    expect(isHistoryRecordingSuspended()).toBe(false)
  })

  it('uses a nesting counter so nested history moves keep recording suspended', async () => {
    await withoutHistoryRecording(async () => {
      expect(isHistoryRecordingSuspended()).toBe(true)
      await withoutHistoryRecording(async () => {
        expect(isHistoryRecordingSuspended()).toBe(true)
      })
      expect(isHistoryRecordingSuspended()).toBe(true)
    })
    expect(isHistoryRecordingSuspended()).toBe(false)
  })

  it('creates isolated instances (ADR-0040)', () => {
    const a = createNavigationHistory()
    const b = createNavigationHistory()
    a.getState().push('/a.md')
    expect(a.getState().entries).toHaveLength(1)
    expect(b.getState().entries).toHaveLength(0)
    expect(useNavigationHistory.getState().entries).toHaveLength(0)
  })

  it('ADR-0042: the tabId argument is compatibility-only — suppression is always global', async () => {
    expect(isHistoryRecordingSuspended('a')).toBe(false)
    await withoutHistoryRecording(
      async () => expect(isHistoryRecordingSuspended('a')).toBe(true),
      'a',
    )
    expect(isHistoryRecordingSuspended('a')).toBe(false)
    await withoutHistoryRecording(async () => {
      expect(isHistoryRecordingSuspended('a')).toBe(true)
      expect(isHistoryRecordingSuspended('b')).toBe(true)
      expect(isHistoryRecordingSuspended()).toBe(true)
    }, 'a')
    // Nesting keeps suppression until the outer scope ends.
    await withoutHistoryRecording(
      async () =>
        withoutHistoryRecording(async () => {
          expect(isHistoryRecordingSuspended('a')).toBe(true)
        }, 'a'),
      'a',
    )
    expect(isHistoryRecordingSuspended('a')).toBe(false)
  })

  it('ADR-0042: marks the current entry replayable across a workspace switch', () => {
    const h = createNavigationHistory()
    h.getState().push('/old/sub/a.md', { tabId: 'tab-a' })
    h.getState().markCurrentEntryForSwitch('/old', 'tab-b')
    expect(h.getState().entryAt(0)).toMatchObject({
      path: '/old/sub/a.md',
      openMode: 'external-switch',
      replayRoot: '/old',
      tabId: 'tab-a',
    })
    // A cross-switch entry survives pruning by the new root, unlike an in-place one.
    h.getState().pruneOutOfRoot('/new')
    expect(h.getState().entries).toHaveLength(1)
  })

  it('ADR-0042: marking keeps an existing tabId and tolerates missing ones', () => {
    const h = createNavigationHistory()
    h.getState().push('/old/a.md')
    h.getState().markCurrentEntryForSwitch('/old')
    expect(h.getState().entryAt(0)?.tabId).toBeUndefined()
    h.getState().push('/old/b.md', { tabId: 'tab-a' })
    h.getState().markCurrentEntryForSwitch('/old', 'tab-b')
    expect(h.getState().entryAt(1)?.tabId).toBe('tab-a')
  })

  it('ADR-0042: records tabId and editor position, and updates the current entry in place', () => {
    const h = createNavigationHistory()
    h.getState().push('/a.md', { tabId: 'tab-a', position: { start: 4, end: 9 } })
    h.getState().push('/b.md', { tabId: 'tab-b' })
    expect(h.getState().entryAt(0)).toMatchObject({
      path: '/a.md',
      tabId: 'tab-a',
      position: { start: 4, end: 9 },
    })
    h.getState().updateCurrentPosition({ start: 12, end: 12 })
    expect(h.getState().entryAt(0)?.position).toEqual({ start: 4, end: 9 })
    expect(h.getState().entryAt(1)?.position).toEqual({ start: 12, end: 12 })
    expect(h.getState().entries).toHaveLength(2)
    h.getState().updateCurrentPosition(null)
    expect(h.getState().entryAt(1)?.position).toBeUndefined()
  })

  it('pruneOutOfRoot removes in-place entries outside the root, keeps external modes', () => {
    const h = createNavigationHistory()
    h.getState().push('/root/a.md')
    h.getState().push('/other/b.md', { openMode: 'external-keep' })
    h.getState().push('/other/c.md', { openMode: 'external-switch' })
    h.getState().push('/root/d.md')
    h.getState().setCursor(3)
    h.getState().pruneOutOfRoot('/root')
    expect(h.getState().entries.map((e) => e.path)).toEqual([
      '/root/a.md',
      '/other/b.md',
      '/other/c.md',
      '/root/d.md',
    ])
    h.getState().pruneOutOfRoot('/root/sub')
    expect(h.getState().entries.map((e) => e.path)).toEqual(['/other/b.md', '/other/c.md'])
    expect(h.getState().cursor).toBe(1)
  })
})
