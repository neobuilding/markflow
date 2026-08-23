// Unit tests for the TemplateSource I/O boundary (template-source.mjs).
//
// The default implementation reads a file via readFileSync; we mock that one
// call so the read path is covered without touching disk. `read` intentionally
// lets readFileSync throw (the caller decides whether to fall back), so the
// single-line body is fully covered by a successful read.
import { describe, it, expect, vi } from 'vitest'
import { createFsTemplateSource } from './template-source.mjs'

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }))
vi.mock('./fs-glue.mjs', () => ({ readFileSync }))

describe('createFsTemplateSource', () => {
  it('reads the template file as a utf8 string', () => {
    readFileSync.mockReturnValue('# Template\n')
    const src = createFsTemplateSource()
    expect(src.read('.github/pull-request-template.md')).toBe('# Template\n')
    expect(readFileSync).toHaveBeenCalledWith('.github/pull-request-template.md', 'utf8')
  })
})
