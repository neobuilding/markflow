// @vitest-environment node
// Coverage for the failure path of `nodeDiskIO.writeFileAtomic`: when the cross-device (or
// otherwise failing) `renameSync` throws, the temp file must still be cleaned up and the error
// propagated. The real `node:fs` is used for everything except `renameSync`, which is forced to
// throw.
import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { mkTestDir } from '../test-support/tmp'

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(() => {
      throw new Error('simulated rename failure')
    }),
    // Keep the real behaviour but turn it into a spy so we can assert on the cleanup call.
    unlinkSync: vi.fn((...args: Parameters<typeof actual.unlinkSync>) =>
      actual.unlinkSync(...args),
    ),
  }
})

import { renameSync, unlinkSync } from 'node:fs'
import { nodeDiskIO } from './disk-io'

describe('nodeDiskIO.writeFileAtomic — failure path', () => {
  it('cleans up the temp file and rethrows when rename fails', () => {
    const root = mkTestDir('mf-diskio-atomic-fail-')
    const p = join(root, 'f.txt')

    // `writeFileAtomic` is synchronous: the failed `renameSync` is caught, the temp file removed,
    // and the error propagated.
    expect(() => nodeDiskIO.writeFileAtomic(p, Buffer.from('x'))).toThrow(
      /simulated rename failure/,
    )
    expect(renameSync).toHaveBeenCalled()
    // The cleanup must target the same-directory `.tmp` spill file, never the target.
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.tmp'))
    expect(unlinkSync).not.toHaveBeenCalledWith(p)
  })
})
