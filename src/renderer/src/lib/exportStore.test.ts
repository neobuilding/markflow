import { describe, it, expect, beforeEach } from 'vitest'
import { setExportHtml, getExportHtml, setExportContent, getExportContent } from './exportStore'

describe('exportStore', () => {
  beforeEach(() => {
    setExportHtml('')
    setExportContent('')
  })

  it('round-trips the sanitized preview HTML', () => {
    setExportHtml('<h1>Hi</h1>')
    expect(getExportHtml()).toBe('<h1>Hi</h1>')
  })

  it('overwrites previously stored HTML', () => {
    setExportHtml('a')
    setExportHtml('b')
    expect(getExportHtml()).toBe('b')
  })

  it('round-trips the raw markdown content', () => {
    setExportContent('# Title\n\nbody')
    expect(getExportContent()).toBe('# Title\n\nbody')
  })

  it('overwrites previously stored content', () => {
    setExportContent('one')
    setExportContent('two')
    expect(getExportContent()).toBe('two')
  })
})
