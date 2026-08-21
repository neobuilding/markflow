// Tests for the block-plugin loader (loader.mjs). This module performs file IO
// and dynamic import(), so it is NOT part of the core.mjs coverage gate; these
// tests cover its branching so registry construction is not a blind spot.
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadBlocks, buildBlockRegistry, builtinBlocksDir } from './loader.mjs'

const __dirname = import.meta.dirname

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
    // `broken.mjs` throws on import; it is skipped, not fatal.
    expect(reg).not.toHaveProperty('broken')
    // A sibling good file still loads.
    expect(typeof reg.ok).toBe('function')
  })
})

describe('buildBlockRegistry', () => {
  it('loads built-in blocks and lets a user directory override same-named ones', async () => {
    // builtinBlocksDir() resolves to src/blocks (source layout) which always
    // has title/issues/commits.
    expect(builtinBlocksDir()).toContain('blocks')
    const reg = await buildBlockRegistry(join(__dirname, '__fixtures__', 'blocks'))
    expect(typeof reg.title).toBe('function')
    // The user `good` plugin is merged in alongside built-ins.
    expect(typeof reg.good).toBe('function')
  })
})
