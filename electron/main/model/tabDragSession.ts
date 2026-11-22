import type { TabDragResult, TabHandoff } from '../../../shared/tabTypes'

// ADR-0040: main-process drag-session registry. Pure TypeScript with an injected
// clock/id factory — no Electron import — so the single-consumption and race rules
// are unit-testable at the lowest layer (docs/agents/testing.md).

const SESSION_TTL_MS = 5_000

export interface DragSession {
  token: string
  handoff: TabHandoff
  /** webContents.id of the renderer that started the drag (exact, no active fallback). */
  sourceWindowId: number
  state: 'active' | 'consumed'
  createdAt: number
  /** Set when the destination confirmed a successful seed; releases the source tab. */
  acknowledged: boolean
  /** Set when the destination read the handoff (take-handoff is a one-shot read). */
  taken: boolean
}

export interface SessionLookup {
  session?: DragSession
  result: TabDragResult
}

export class TabDragSessionRegistry {
  private readonly sessions = new Map<string, DragSession>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly makeToken: () => string = () => `drag-${Math.random().toString(36).slice(2)}`,
  ) {}

  begin(handoff: TabHandoff, sourceWindowId: number): string {
    this.pruneExpired()
    const token = this.makeToken()
    this.sessions.set(token, {
      token,
      handoff,
      sourceWindowId,
      state: 'active',
      createdAt: this.now(),
      acknowledged: false,
      taken: false,
    })
    return token
  }

  get(token: string): DragSession | undefined {
    return this.sessions.get(token)
  }

  /**
   * A drop on a tab bar. The caller passes the target window id (resolved from the
   * IPC sender's ALS scope); main decides same-window vs cross-window so renderers
   * never have to guess. A same-window drop does NOT consume the token: the renderer
   * follows up with moveTab + cancel-drag.
   */
  consumeDrop(token: string, targetWindowId: number): SessionLookup {
    const session = this.lookupActive(token)
    if (!session) return { result: this.resultFor(token) }
    if (session.sourceWindowId === targetWindowId) {
      return { session, result: 'same-window' }
    }
    session.state = 'consumed'
    return { session, result: 'consumed' }
  }

  /** Detach to a new window. Always consumes (there is no target tab bar to compare). */
  consumeDetach(token: string): SessionLookup {
    const session = this.lookupActive(token)
    if (!session) return { result: this.resultFor(token) }
    session.state = 'consumed'
    return { session, result: 'consumed' }
  }

  /** Move to an explicitly chosen window (menu path). Reuses the drag session handoff. */
  consumeMoveToWindow(token: string, targetWindowId: number): SessionLookup {
    return this.consumeDrop(token, targetWindowId)
  }

  cancel(token: string): void {
    const session = this.sessions.get(token)
    if (!session || session.state !== 'active') return
    session.state = 'consumed'
    session.acknowledged = true
  }

  /** Destination confirms it seeded the tab; only now may the source dispose its copy. */
  acknowledge(token: string): boolean {
    const session = this.sessions.get(token)
    if (!session || session.state !== 'consumed' || session.acknowledged) return false
    session.acknowledged = true
    return true
  }

  /** The new window reads (and clears) the pending handoff exactly once. */
  takeHandoff(token: string): TabHandoff | null {
    const session = this.sessions.get(token)
    if (!session || session.state !== 'consumed' || session.taken) return null
    session.taken = true
    return session.handoff
  }

  /** Expire ACTIVE sessions older than the TTL; keep consumed ones for duplicate detection. */
  pruneExpired(now = this.now()): number {
    let removed = 0
    for (const [token, session] of this.sessions) {
      if (session.state === 'active' && now - session.createdAt >= SESSION_TTL_MS) {
        this.sessions.delete(token)
        removed += 1
      }
    }
    return removed
  }

  private lookupActive(token: string): DragSession | undefined {
    this.pruneExpired()
    const session = this.sessions.get(token)
    return session?.state === 'active' ? session : undefined
  }

  private resultFor(token: string): TabDragResult {
    return this.sessions.has(token) ? 'expired' : 'no-session'
  }
}
