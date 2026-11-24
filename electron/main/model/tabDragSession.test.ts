// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { TabDragSessionRegistry } from './tabDragSession'
import type { TabHandoff } from '../../../shared/tabTypes'

const handoff = (tabId = 'tab-1'): TabHandoff => ({
  tabId,
  documentId: 'doc-1',
  filePath: 'C:\\work\\a.md',
  workspaceRoot: 'C:\\work',
  content: null,
  title: 'a.md',
  external: false,
  isNewUnsaved: false,
  eol: '\n',
  history: [{ path: 'C:\\work\\a.md' }],
  cursor: 0,
})

describe('TabDragSessionRegistry (ADR-0040)', () => {
  it('consumes a drop exactly once and reports expired afterwards', () => {
    const now = 1_000
    let counter = 0
    const registry = new TabDragSessionRegistry(
      () => now,
      () => `token-${++counter}`,
    )
    const token = registry.begin(handoff(), 1)
    expect(token).toBe('token-1')
    expect(registry.consumeDrop(token, 2)).toEqual({
      session: registry.get(token),
      result: 'consumed',
    })
    expect(registry.consumeDrop(token, 2).result).toBe('expired')
  })

  it('does not consume a same-window drop', () => {
    const registry = new TabDragSessionRegistry()
    const token = registry.begin(handoff(), 7)
    const lookup = registry.consumeDrop(token, 7)
    expect(lookup.result).toBe('same-window')
    expect(registry.get(token)?.state).toBe('active')
    // The renderer's follow-up cancel consumes it.
    registry.cancel(token)
    expect(registry.get(token)?.state).toBe('consumed')
    expect(registry.consumeDrop(token, 8).result).toBe('expired')
  })

  it('detach consumes, take-handoff is one-shot', () => {
    const registry = new TabDragSessionRegistry()
    const token = registry.begin(handoff(), 1)
    expect(registry.consumeDetach(token).result).toBe('consumed')
    expect(registry.takeHandoff(token)).toEqual(handoff())
    expect(registry.takeHandoff(token)).toBeNull()
  })

  it('move-to-window reuses the same session semantics as drop', () => {
    const registry = new TabDragSessionRegistry()
    const token = registry.begin(handoff(), 1)
    expect(registry.consumeMoveToWindow(token, 1).result).toBe('same-window')
    expect(registry.consumeMoveToWindow(token, 2).result).toBe('consumed')
  })

  it('acknowledges only a consumed session, once', () => {
    const registry = new TabDragSessionRegistry()
    const token = registry.begin(handoff(), 1)
    expect(registry.acknowledge(token)).toBe(false)
    expect(registry.acknowledge('unknown')).toBe(false)
    registry.consumeDetach(token)
    expect(registry.acknowledge(token)).toBe(true)
    expect(registry.acknowledge(token)).toBe(false)
  })

  it('cancel is a no-op for unknown and consumed sessions', () => {
    const registry = new TabDragSessionRegistry()
    const token = registry.begin(handoff(), 1)
    registry.cancel('unknown')
    registry.consumeDetach(token)
    registry.cancel(token)
    // A cancel after consumption must not masquerade as the destination ACK.
    expect(registry.get(token)?.acknowledged).toBe(false)
  })

  it('refuses a duplicate renderer-supplied token without overwriting the session', () => {
    const registry = new TabDragSessionRegistry()
    const first = registry.begin(handoff('first'), 1, 'fixed-token')
    const second = registry.begin(handoff('second'), 2, 'fixed-token')
    expect(first).toBe('fixed-token')
    expect(second).toBe('')
    expect(registry.get('fixed-token')?.handoff.tabId).toBe('first')
  })

  it('expires active and unacknowledged consumed sessions once the 5s TTL elapses', () => {
    let now = 0
    const registry = new TabDragSessionRegistry(() => now)
    const stale = registry.begin(handoff('stale'), 1)
    now = 4_999
    expect(registry.pruneExpired()).toBe(0)
    const consumed = registry.begin(handoff('consumed'), 1)
    registry.consumeDetach(consumed)
    expect(registry.pruneExpired()).toBe(0) // still inside the duplicate-detection window
    now = 10_000
    expect(registry.pruneExpired()).toBe(2)
    expect(registry.consumeDrop(stale, 2).result).toBe('no-session')
    expect(registry.consumeDrop(consumed, 2).result).toBe('no-session')
  })

  it('returns no-session for a token that was never issued', () => {
    const registry = new TabDragSessionRegistry()
    expect(registry.consumeDetach('never').result).toBe('no-session')
    expect(registry.cancel('never')).toBeUndefined()
  })
})
