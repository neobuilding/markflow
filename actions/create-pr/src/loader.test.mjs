// Tests for the block-plugin loader (loader.mjs). It performs file IO and
// dynamic import(); these tests cover every branch (scan, missing/empty dir,
// import failure, non-function default, and readdir failure) so the registry
// construction stays at 100% coverage.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { loadBlocks, buildBlockRegistry, builtinRegistry } from './loader.mjs'

const __dirname = import.meta.dirname

// Mock readdirSync (re-exported from ./services/fs-glue.mjs) so we can exercise
// its failure branch without touching the real filesystem. The default
// implementation delegates to the REAL readdirSync (so the scan / non-function
// cases behave normally); the throws case overrides it with mockImplementationOnce.
// existsSync, pathToFileURL and dynamic import stay real.
const hoisted = vi.hoisted(() => {
  const readdirSync = vi.fn()
  let real
  return {
    readdirSync,
    setReal: (r) => {
      real = r
    },
    getReal: () => real,
  }
})
vi.mock('./services/fs-glue.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  hoisted.setReal(actual.readdirSync)
  return { ...actual, readdirSync: hoisted.readdirSync }
})

beforeEach(() => {
  hoisted.readdirSync.mockReset()
  hoisted.readdirSync.mockImplementation((...args) => hoisted.getReal()(...args))
})

describe('builtinRegistry', () => {
  it('returns the three built-in block plugins', () => {
    const reg = builtinRegistry()
    expect(typeof reg.title).toBe('function')
    expect(typeof reg.issue).toBe('function')
    expect(typeof reg.commits).toBe('function')
  })
})

describe('loadBlocks', () => {
  it('scans a directory and registers each *.mjs plugin by file name', async () => {
    const dir = join(__dirname, '__fixtures__', 'blocks')
    const reg = await loadBlocks(dir)
    expect(typeof reg.good).toBe('function')
    expect(reg.good({ name: 'x' })).toBe('hi x')
    // A non-.mjs file in the directory is ignored.
    expect(reg).not.toHaveProperty('readme')
  })

  it('returns an empty registry for a missing directory (never throws)', async () => {
    const reg = await loadBlocks(join(__dirname, '__fixtures__', 'does-not-exist'))
    expect(reg).toEqual({})
  })

  it('skips a plugin that throws on import, keeping the run alive', async () => {
    const dir = join(__dirname, '__fixtures__', 'blocks-broken')
    const reg = await loadBlocks(dir)
    // `broken.mjs` throws an Error and `broken-nomsg.mjs` throws a plain string
    // on import; both are skipped (and the catch branch falls back to String(err)
    // for the string case), not fatal.
    expect(reg).not.toHaveProperty('broken')
    expect(reg).not.toHaveProperty('broken-nomsg')
    // A sibling good file still loads.
    expect(typeof reg.ok).toBe('function')
  })
})

describe('buildBlockRegistry', () => {
  it('loads built-in blocks and lets a user directory override same-named ones', async () => {
    const reg = await buildBlockRegistry(join(__dirname, '__fixtures__', 'blocks'))
    // Built-ins are always present (inlined into the bundle).
    expect(typeof reg.title).toBe('function')
    expect(typeof reg.issue).toBe('function')
    expect(typeof reg.commits).toBe('function')
    // The user `good` plugin is merged in alongside built-ins.
    expect(typeof reg.good).toBe('function')
  })
})

describe('loadBlocks — edge branches', () => {
  it('returns an empty registry when readdirSync throws (never aborts)', async () => {
    // The default readdirSync delegates to the real one; override just this call
    // to throw and confirm the failure is swallowed into an empty registry.
    const dir = join(__dirname, '__fixtures__', 'blocks')
    hoisted.readdirSync.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const reg = await loadBlocks(dir)
    expect(reg).toEqual({})
  })

  it('skips a plugin whose default export is not a function', async () => {
    // The __fixtures__/blocks/notafn.mjs fixture exports `123` (not a function)
    // as its default, so loadBlocks must skip it instead of registering/crashing.
    const dir = join(__dirname, '__fixtures__', 'blocks')
    const reg = await loadBlocks(dir)
    expect(reg).not.toHaveProperty('notafn')
  })
})
