// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __emitFolderEvent,
  addWatchedFolder,
  markOwnWrite,
  startFolderWatching,
  stopFolderWatching,
  type FolderWatchHandlers,
} from './folderWatcher'

// chokidar is replaced wholesale: creating a real recursive watcher would make these
// tests depend on OS event latency. The mock only has to satisfy the API surface
// folderWatcher uses, and record what was started / added / closed.
const state = vi.hoisted(() => ({
  instances: [] as Array<{
    paths: string[]
    added: string[]
    closed: boolean
    handlers: Record<string, (p: string) => void>
  }>,
}))

vi.mock('chokidar', () => ({
  watch: (paths: string | string[], _opts?: unknown) => {
    const inst = {
      paths: Array.isArray(paths) ? paths : [paths],
      added: [] as string[],
      closed: false,
      handlers: {} as Record<string, (p: string) => void>,
      add(p: string | string[]) {
        inst.added.push(...(Array.isArray(p) ? p : [p]))
        return inst
      },
      on(event: string, cb: (p: string) => void) {
        inst.handlers[event] = cb
        return inst
      },
      async close() {
        inst.closed = true
      },
    }
    state.instances.push(inst)
    return inst
  },
}))

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

let seen: { added: string[]; removed: string[]; changed: string[] }
function install(): FolderWatchHandlers {
  seen = { added: [], removed: [], changed: [] }
  const h: FolderWatchHandlers = {
    onFileAdded: (p) => seen.added.push(p),
    onFileRemoved: (p) => seen.removed.push(p),
    onFileChanged: (p) => seen.changed.push(p),
  }
  startFolderWatching(h)
  return h
}

// The watcher and the open-folder set are module-level singletons; reset between tests.
beforeEach(async () => {
  await stopFolderWatching()
  state.instances.length = 0
})

// Must run before any startFolderWatching() call: it pins the guard that dispatch
// drops events when no handlers have been installed yet.
describe('folderWatcher — before handlers are installed', () => {
  it('drops events silently when no handlers are installed', () => {
    addWatchedFolder(tmpDir('fw-nohandler-'))
    expect(() => {
      __emitFolderEvent('add', '/w/a.md')
      __emitFolderEvent('change', '/w/a.md')
      __emitFolderEvent('unlink', '/w/a.md')
    }).not.toThrow()
  })
})

describe('folderWatcher — lifecycle', () => {
  it('starts no watcher until a folder has been opened', () => {
    install()
    expect(state.instances).toHaveLength(0)
  })

  it('starts a watcher over the opened folder', () => {
    install()
    const dir = tmpDir('fw-start-')
    addWatchedFolder(dir)
    expect(state.instances).toHaveLength(1)
    expect(state.instances[0].paths).toEqual([dir])
  })

  it('adds further folders to the running watcher instead of starting a second one', () => {
    install()
    addWatchedFolder(tmpDir('fw-one-'))
    addWatchedFolder(tmpDir('fw-two-'))
    expect(state.instances).toHaveLength(1)
    expect(state.instances[0].added).toHaveLength(1)
  })

  it('ignores a folder already covered by one being watched', () => {
    install()
    const root = tmpDir('fw-root-')
    addWatchedFolder(root)
    addWatchedFolder(join(root, 'nested'))
    expect(state.instances[0].added).toHaveLength(0)
  })

  it('ignores an empty folder path', () => {
    install()
    addWatchedFolder('')
    expect(state.instances).toHaveLength(0)
  })

  it('does not start a second watcher when one is already running', () => {
    install()
    addWatchedFolder(tmpDir('fw-reinstall-'))
    const inst = state.instances[0]

    // Re-installing handlers (as a repeated registerDocumentHandlers would) must
    // reuse the running watcher instead of orphaning it.
    install()

    expect(state.instances).toHaveLength(1)
    expect(state.instances[0]).toBe(inst)
    expect(inst.closed).toBe(false)
  })

  it('closes the watcher on stop and forgets the folders', async () => {
    install()
    const dir = tmpDir('fw-stop-')
    addWatchedFolder(dir)
    const inst = state.instances[0]

    await stopFolderWatching()

    expect(inst.closed).toBe(true)
  })

  it('opens a fresh watcher after a stop (previous folders were forgotten)', async () => {
    install()
    addWatchedFolder(tmpDir('fw-before-'))
    await stopFolderWatching()

    addWatchedFolder(tmpDir('fw-after-'))

    expect(state.instances).toHaveLength(2)
    expect(state.instances[0].closed).toBe(true)
    expect(state.instances[1].closed).toBe(false)
  })

  it('tolerates stopping when nothing is being watched', async () => {
    install()
    await expect(stopFolderWatching()).resolves.toBeUndefined()
  })
})

describe('folderWatcher — dispatching real chokidar events', () => {
  it('routes add / unlink / change to the matching handler', () => {
    install()
    const inst = state.instances[0] ?? undefined

    addWatchedFolder(tmpDir('fw-dispatch-'))
    const w = state.instances[0]
    w.handlers.add('/w/a.md')
    w.handlers.unlink('/w/b.md')
    w.handlers.change('/w/c.md')

    expect(seen).toEqual({ added: ['/w/a.md'], removed: ['/w/b.md'], changed: ['/w/c.md'] })
    expect(inst).toBeUndefined()
  })

  it('swallows a watcher error instead of crashing the main process', () => {
    install()
    addWatchedFolder(tmpDir('fw-error-'))
    const w = state.instances[0]
    expect(() => w.handlers.error('/w/boom.md')).not.toThrow()
  })

  it('ignores non-Markdown paths for every event kind', () => {
    install()
    addWatchedFolder(tmpDir('fw-nonmd-'))
    __emitFolderEvent('add', '/w/a.txt')
    __emitFolderEvent('unlink', '/w/b.html')
    __emitFolderEvent('change', '/w/c')
    expect(seen).toEqual({ added: [], removed: [], changed: [] })
  })

  it('accepts Markdown paths in any letter case', () => {
    install()
    addWatchedFolder(tmpDir('fw-case-'))
    __emitFolderEvent('add', '/w/UPPER.MD')
    __emitFolderEvent('add', '/w/Mixed.Markdown')
    expect(seen.added).toEqual(['/w/UPPER.MD', '/w/Mixed.Markdown'])
  })
})

describe('folderWatcher — own-write suppression', () => {
  it('hides the change raised by a write the app performed itself', () => {
    install()
    markOwnWrite('/w/mine.md')
    __emitFolderEvent('change', '/w/mine.md')
    expect(seen.changed).toEqual([])
  })

  it('still reports add / unlink for a file the app just wrote', () => {
    install()
    markOwnWrite('/w/mine.md')
    __emitFolderEvent('add', '/w/mine.md')
    __emitFolderEvent('unlink', '/w/mine.md')
    expect(seen.added).toEqual(['/w/mine.md'])
    expect(seen.removed).toEqual(['/w/mine.md'])
  })

  it('reports the change again once the suppression window has elapsed', () => {
    vi.useFakeTimers()
    try {
      install()
      markOwnWrite('/w/mine.md')
      vi.advanceTimersByTime(2001)
      __emitFolderEvent('change', '/w/mine.md')
      expect(seen.changed).toEqual(['/w/mine.md'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes expired entries when the suppression map grows past its cap', () => {
    vi.useFakeTimers()
    try {
      install()
      // Fill past OWN_WRITE_MAX_ENTRIES (256) with entries that are all still live.
      for (let i = 0; i < 257; i++) markOwnWrite(`/w/live-${i}.md`)
      // They are all within the window, so pruning must not drop any of them.
      __emitFolderEvent('change', '/w/live-0.md')
      expect(seen.changed).toEqual([])

      // Expire them, then push one more: the pruning pass clears the stale entries.
      vi.advanceTimersByTime(2001)
      markOwnWrite('/w/fresh.md')
      __emitFolderEvent('change', '/w/live-256.md')
      expect(seen.changed).toEqual(['/w/live-256.md'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets suppressions when watching stops', async () => {
    install()
    markOwnWrite('/w/mine.md')
    await stopFolderWatching()
    install()
    __emitFolderEvent('change', '/w/mine.md')
    expect(seen.changed).toEqual(['/w/mine.md'])
  })
})
