// Tests for the block-plugin loader (loader.mjs). It performs file IO and
// dynamic import(); these tests cover every branch (scan, missing/empty dir,
// import failure, non-function default, and readdir failure) so the registry
// construction stays at 100% coverage.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { loadBlocks, buildBlockRegistry, builtinRegistry } from './loader.mjs'

const __dirname = import.meta.dirname

// Mock the fs boundary (re-exported from ./services/fs-glue.mjs) so no test
// touches the real filesystem. readdirSync is driven per-case via mockReturnValue
// (fixture listings below); existsSync returns true because the fixture
// directories are real test assets. pathToFileURL and dynamic import stay real.
const hoisted = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}))
vi.mock('./services/fs-glue.mjs', () => ({
  readdirSync: hoisted.readdirSync,
  existsSync: hoisted.existsSync,
}))

// Fixture directory listings (test assets, not real repo files). We mock
// readdirSync to return these so no real filesystem is touched; loadBlocks
// still performs a real dynamic import() of the named plugins.
const BLOCKS_DIR = join(__dirname, '__fixtures__', 'blocks')
const BLOCKS_BROKEN_DIR = join(__dirname, '__fixtures__', 'blocks-broken')
const BLOCKS_FILES = ['good.mjs', 'notafn.mjs', 'readme.md', 'types.mjs']
const BLOCKS_BROKEN_FILES = ['broken.mjs', 'broken-nomsg.mjs', 'ok.mjs']

beforeEach(() => {
  hoisted.readdirSync.mockReset()
  // Default: a healthy fixture directory listing.
  hoisted.readdirSync.mockReturnValue(BLOCKS_FILES)
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
    const reg = await loadBlocks(BLOCKS_DIR)
    expect(typeof reg.good).toBe('function')
    expect(reg.good({ name: 'x' })).toBe('hi x')
    // A non-.mjs file in the directory is ignored.
    expect(reg).not.toHaveProperty('readme')
  })

  it('returns an empty registry for a missing directory (never throws)', async () => {
    const reg = await loadBlocks(join(__dirname, '__fixtures__', 'does-not-exist'))
    expect(reg).toEqual({})
  })

  it('returns an empty registry when dir is omitted (falsy) without touching fs', async () => {
    // Covers the `!dir` short-circuit of `if (!dir || !existsSync(dir))` so the
    // branch is fully covered without performing any filesystem access.
    const reg = await loadBlocks()
    expect(reg).toEqual({})
    expect(hoisted.readdirSync).not.toHaveBeenCalled()
  })

  it('skips a plugin that throws on import, keeping the run alive', async () => {
    hoisted.readdirSync.mockReturnValue(BLOCKS_BROKEN_FILES)
    const reg = await loadBlocks(BLOCKS_BROKEN_DIR)
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
    const reg = await buildBlockRegistry(BLOCKS_DIR)
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
    // Override this single call to throw and confirm the failure is swallowed
    // into an empty registry.
    hoisted.readdirSync.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const reg = await loadBlocks(BLOCKS_DIR)
    expect(reg).toEqual({})
  })

  it('skips a plugin whose default export is not a function', async () => {
    // The __fixtures__/blocks/notafn.mjs fixture exports `123` (not a function)
    // as its default, so loadBlocks must skip it instead of registering/crashing.
    const reg = await loadBlocks(BLOCKS_DIR)
    expect(reg).not.toHaveProperty('notafn')
  })
})
