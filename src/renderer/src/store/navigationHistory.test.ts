import { beforeEach, describe, expect, it } from 'vitest'
import { useNavigationHistory } from './navigationHistory'

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
})
