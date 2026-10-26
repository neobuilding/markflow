// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkTestDir } from '../test-support/tmp'
import {
  __emitFolderEvent,
  __emitFolderDirEvent,
  markOwnWrite,
  startFolderWatching,
  stopFolderWatching,
  pauseFolderWatching,
  resumeFolderWatching,
  refreshFolderWatching,
  type FolderWatchHandlers,
} from './folderWatcher'
import { setWorkspaceRoot, getWorkspaceRoot } from './workspaceRoot'

// chokidar is replaced wholesale: creating a real recursive watcher would make these
// tests depend on OS event latency. The mock only has to satisfy the API surface
// folderWatcher uses, and record what was started / added / closed.
const state = vi.hoisted(() => ({
  instances: [] as Array<{
    paths: string[]
    added: string[]
    closed: boolean
    handlers: Record<string, (p: string) => void>
    // The real options handed to chokidar, so tests can exercise the very
    // `ignored` matcher production installs (rather than a copy of it).
    options: { ignored?: unknown } | undefined
  }>,
}))

vi.mock('chokidar', () => ({
  watch: (paths: string | string[], opts?: { ignored?: unknown }) => {
    const inst = {
      paths: Array.isArray(paths) ? paths : [paths],
      added: [] as string[],
      closed: false,
      handlers: {} as Record<string, (p: string) => void>,
      options: opts as { ignored?: unknown } | undefined,
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
  return mkTestDir(prefix)
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

// Opening a root REPLACES the workspace (ADR-0023): the store-side reset is tested with the
// documents IPC, here we only care that the watcher follows the single root.
function openRoot(dir: string): void {
  setWorkspaceRoot(dir)
  refreshFolderWatching()
}

// The watcher and the workspace root are module-level singletons; reset between tests.
beforeEach(async () => {
  await stopFolderWatching()
  setWorkspaceRoot(null)
  state.instances.length = 0
})

// Must run before any startFolderWatching() call: it pins the guard that dispatch
// drops events when no handlers have been installed yet.
describe('folderWatcher — before handlers are installed', () => {
  it('drops events silently when no handlers are installed', () => {
    openRoot(tmpDir('fw-nohandler-'))
    expect(() => {
      __emitFolderEvent('add', '/w/a.md')
      __emitFolderEvent('change', '/w/a.md')
      __emitFolderEvent('unlink', '/w/a.md')
    }).not.toThrow()
  })

  it('drops directory events silently when no handlers are installed', () => {
    // dispatchDir guards on a null handler set, exactly like dispatch does for files:
    // this covers the `if (!h) return` branch that is otherwise never taken once a
    // handler set has been installed.
    expect(() => {
      __emitFolderDirEvent('addDir', '/w/folder')
      __emitFolderDirEvent('unlinkDir', '/w/folder')
    }).not.toThrow()
  })
})

describe('folderWatcher — lifecycle', () => {
  it('starts no watcher until a root has been opened', () => {
    install()
    expect(state.instances).toHaveLength(0)
    expect(getWorkspaceRoot()).toBeNull()
  })

  it('starts a watcher over the opened root', () => {
    install()
    const dir = tmpDir('fw-start-')
    openRoot(dir)
    expect(state.instances).toHaveLength(1)
    expect(state.instances[0].paths).toEqual([dir])
  })

  it('ignores an empty root', () => {
    install()
    openRoot('')
    expect(state.instances).toHaveLength(0)
  })

  it('replacing the root closes the previous watcher — only ever ONE root is watched (D14/D21)', () => {
    install()
    openRoot(tmpDir('fw-replace-a-'))
    const first = state.instances[0]
    openRoot(tmpDir('fw-replace-b-'))
    expect(first.closed).toBe(true)
    expect(state.instances).toHaveLength(2)
    expect(state.instances[1].closed).toBe(false)
    expect(getWorkspaceRoot()).not.toBeNull()
  })

  it('closing the workspace stops watching', async () => {
    install()
    openRoot(tmpDir('fw-clear-'))
    const inst = state.instances[0]
    setWorkspaceRoot(null)
    await stopFolderWatching()
    expect(inst.closed).toBe(true)
    expect(getWorkspaceRoot()).toBeNull()
  })

  it('does not start a second watcher when one is already running', () => {
    install()
    openRoot(tmpDir('fw-reinstall-'))
    const inst = state.instances[0]

    // Re-installing handlers (as a repeated registerDocumentHandlers would) must
    // reuse the running watcher instead of orphaning it.
    install()

    expect(inst.closed).toBe(false)
  })

  it('closes the watcher on stop', async () => {
    install()
    openRoot(tmpDir('fw-stop-'))
    const inst = state.instances[0]

    await stopFolderWatching()

    expect(inst.closed).toBe(true)
  })

  it('opens a fresh watcher after a stop', async () => {
    install()
    openRoot(tmpDir('fw-before-'))
    await stopFolderWatching()

    openRoot(tmpDir('fw-after-'))

    expect(state.instances).toHaveLength(2)
    expect(state.instances[0].closed).toBe(true)
    expect(state.instances[1].closed).toBe(false)
  })
})

describe('folderWatcher — dispatching real chokidar events', () => {
  it('routes add / unlink / change to the matching handler', () => {
    install()
    const inst = state.instances[0] ?? undefined

    openRoot(tmpDir('fw-dispatch-'))
    const w = state.instances[0]
    w.handlers.add('/w/a.md')
    w.handlers.unlink('/w/b.md')
    w.handlers.change('/w/c.md')

    expect(seen).toEqual({ added: ['/w/a.md'], removed: ['/w/b.md'], changed: ['/w/c.md'] })
    expect(inst).toBeUndefined()
  })

  it('swallows a watcher error instead of crashing the main process', () => {
    install()
    openRoot(tmpDir('fw-error-'))
    const w = state.instances[0]
    expect(() => w.handlers.error('/w/boom.md')).not.toThrow()
  })

  it('ignores non-Markdown paths for every event kind', () => {
    install()
    openRoot(tmpDir('fw-nonmd-'))
    __emitFolderEvent('add', '/w/a.txt')
    __emitFolderEvent('unlink', '/w/b.html')
    __emitFolderEvent('change', '/w/c')
    expect(seen).toEqual({ added: [], removed: [], changed: [] })
  })

  it('accepts Markdown paths in any letter case', () => {
    install()
    openRoot(tmpDir('fw-case-'))
    __emitFolderEvent('add', '/w/UPPER.MD')
    __emitFolderEvent('add', '/w/Mixed.Markdown')
    expect(seen.added).toEqual(['/w/UPPER.MD', '/w/Mixed.Markdown'])
  })
})

describe('folderWatcher — the ignored matcher handed to chokidar', () => {
  type Ignored = (path: string, stats?: { isDirectory(): boolean }) => boolean

  function grabIgnored(): Ignored {
    install()
    openRoot(tmpDir('fw-ignored-'))
    const opts = state.instances[0]?.options
    const ignored = Array.isArray(opts?.ignored) ? opts?.ignored[0] : opts?.ignored
    expect(typeof ignored).toBe('function')
    return ignored as Ignored
  }

  const file = { isDirectory: () => false }
  const dir = { isDirectory: () => true }

  it('watches markdown files and ignores everything else', () => {
    const ignored = grabIgnored()
    // Markdown must be watched (ignored === false), whatever the case.
    expect(ignored('/w/note.md', file)).toBe(false)
    expect(ignored('/w/NOTE.MD', file)).toBe(false)
    expect(ignored('/w/n.markdown', file)).toBe(false)
    // Non-markdown files must NOT be watched: this is what keeps build output,
    // coverage reports and images out of the watch set.
    expect(ignored('/w/script.js', file)).toBe(true)
    expect(ignored('/w/style.css', file)).toBe(true)
    expect(ignored('/w/shot.png', file)).toBe(true)
    // The previously hand-listed export artefacts are covered by the same rule.
    expect(ignored('/w/export.html', file)).toBe(true)
    expect(ignored('/w/out.pdf', file)).toBe(true)
    expect(ignored('/w/doc.docx', file)).toBe(true)
    expect(ignored('/w/tmp.tmp', file)).toBe(true)
  })

  it('still traverses directories, except dot dirs and node_modules', () => {
    const ignored = grabIgnored()
    // Directories must be traversed or chokidar cannot recurse into them.
    expect(ignored('/w/sub', dir)).toBe(false)
    expect(ignored('/w/deep/nested', dir)).toBe(false)
    // but never the ones that are pure noise
    expect(ignored('/w/.git', dir)).toBe(true)
    expect(ignored('/w/node_modules', dir)).toBe(true)
    expect(ignored('/w/a/node_modules/b', dir)).toBe(true)
  })

  it('falls back to the path shape when chokidar passes no stats', () => {
    // chokidar may call the matcher without stats; a path with an extension is
    // then treated as a file, one without as a directory.
    const ignored = grabIgnored()
    expect(ignored('/w/note.md')).toBe(false)
    expect(ignored('/w/script.js')).toBe(true)
    expect(ignored('/w/some-dir')).toBe(false)
  })
})

describe('folderWatcher — own-write suppression', () => {
  it('hides the change raised by a write the app performed itself', () => {
    install()
    markOwnWrite('/w/mine.md')
    __emitFolderEvent('change', '/w/mine.md')
    expect(seen.changed).toEqual([])
  })

  it('drops an expired suppression and surfaces the change (isOwnWrite past window)', () => {
    vi.useFakeTimers()
    try {
      install()
      markOwnWrite('/w/mine.md')
      // Advance past OWN_WRITE_SUPPRESS_MS (2000) so the entry has expired.
      vi.advanceTimersByTime(100000)
      __emitFolderEvent('change', '/w/mine.md')
      expect(seen.changed).toEqual(['/w/mine.md'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes expired entries once the own-write map exceeds the cap', () => {
    vi.useFakeTimers()
    try {
      install()
      // Fill well past OWN_WRITE_MAX_ENTRIES (256) with entries that are now expired.
      for (let i = 0; i < 270; i++) markOwnWrite(`/w/f${i}.md`)
      vi.advanceTimersByTime(100000)
      // This mark trips the prune loop (size > 256) and deletes the expired entries.
      markOwnWrite('/w/fresh.md')
      // An expired entry (now pruned) no longer suppresses its change.
      __emitFolderEvent('change', '/w/f0.md')
      expect(seen.changed).toEqual(['/w/f0.md'])
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: the sidebar tree lists FOLDERS, but only file events were ever dispatched —
  // so a folder created or deleted outside the app left the tree stale. `dispatch` drops every
  // non-Markdown path (and a directory never has one), hence the separate directory path.
  describe('directory events (folder tree refresh)', () => {
    function installDirHandlers() {
      const dirs = { added: [] as string[], removed: [] as string[] }
      startFolderWatching({
        onFileAdded: () => {},
        onFileRemoved: () => {},
        onFileChanged: () => {},
        onDirAdded: (p) => dirs.added.push(p),
        onDirRemoved: (p) => dirs.removed.push(p),
      })
      return dirs
    }

    it('routes chokidar addDir / unlinkDir to the directory handlers', () => {
      install()
      openRoot(tmpDir('fw-dirs-'))
      const dirs = installDirHandlers()
      const w = state.instances[0]
      w.handlers.addDir('/w/newfolder')
      w.handlers.unlinkDir('/w/gonefolder')
      expect(dirs).toEqual({ added: ['/w/newfolder'], removed: ['/w/gonefolder'] })
    })

    it('dispatches a directory even though it has no Markdown extension', () => {
      install()
      const dirs = installDirHandlers()
      // The file dispatch would drop this path outright — that is the whole reason for a
      // separate directory dispatch.
      __emitFolderDirEvent('addDir', '/w/plain-folder')
      expect(dirs.added).toEqual(['/w/plain-folder'])
      // And it never leaks into the file handlers.
      expect(seen.added).toEqual([])
    })

    it('is a no-op when the caller supplies no directory handlers', () => {
      install() // file-only handler shape
      expect(() => __emitFolderDirEvent('unlinkDir', '/w/x')).not.toThrow()
    })
  })

  // Regression: deleting a folder that sits inside the watched tree failed on Windows with a
  // permissions error, because chokidar holds an open handle per directory. The delete path
  // therefore pauses the watch first — and must put it back afterwards, even on failure.
  describe('pause / resume (folder delete)', () => {
    it('pause closes the watcher and resume starts a fresh one', async () => {
      install()
      openRoot(tmpDir('fw-pause-'))
      const first = state.instances[0]
      await pauseFolderWatching()
      expect(first.closed).toBe(true)
      resumeFolderWatching()
      expect(state.instances.length).toBe(2)
    })

    it('resume without a prior pause never creates a watcher', async () => {
      await stopFolderWatching()
      state.instances.length = 0
      const before = state.instances.length
      resumeFolderWatching()
      // A resume without a real pause must never create a watcher that was not there.
      expect(state.instances.length).toBe(before)
    })

    it('a second pause is idempotent', async () => {
      install()
      openRoot(tmpDir('fw-pause2-'))
      await pauseFolderWatching()
      const afterFirst = state.instances.length
      await pauseFolderWatching()
      expect(state.instances.length).toBe(afterFirst)
    })

    it('changing the root while paused does not start a watcher behind the pause', async () => {
      // `watchingPaused` survives across tests (module singleton),
      // so a prior test that ended paused would otherwise leak it in and make pauseFolderWatching
      // early-return instead of nulling the watcher.
      resumeFolderWatching()
      await stopFolderWatching()
      state.instances.length = 0
      install()
      openRoot(tmpDir('fw-pause-mid-'))
      await pauseFolderWatching()
      const afterPause = state.instances.length
      // Re-rooting while paused must not create a watcher: resume owns that transition.
      openRoot(tmpDir('fw-pause-mid2-'))
      expect(state.instances.length).toBe(afterPause)
      resumeFolderWatching()
      expect(state.instances.length).toBe(afterPause + 1)
    })
  })
})
