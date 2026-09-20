import { describe, it, expect, beforeEach } from 'vitest'
import {
  setExportHtml,
  getExportHtml,
  setExportContent,
  getExportContent,
  setExportMermaidSlots,
  getExportMermaidSlots,
} from './exportStore'
import { sanitizeHtml } from './sanitize'
import { patchPreviewContent } from './previewRender'

describe('exportStore', () => {
  beforeEach(() => {
    setExportHtml(sanitizeHtml(''))
    setExportContent('')
    setExportMermaidSlots([])
  })

  it('round-trips the sanitized preview HTML', () => {
    setExportHtml(sanitizeHtml('<h1>Hi</h1>'))
    expect(getExportHtml()).toBe('<h1>Hi</h1>')
  })

  it('overwrites previously stored HTML', () => {
    setExportHtml(sanitizeHtml('a'))
    setExportHtml(sanitizeHtml('b'))
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

  it('keeps the SanitizedHtml brand so the value can go straight back into the preview DOM', () => {
    // Plan 01 §5.5 contract #2: the export cache IS the canonical sanitized HTML, so
    // whatever export (or stage-2 rich-text copy) reads back must still satisfy the
    // single DOM write entry — this is a COMPILE-time assertion; if `getExportHtml`
    // ever degrades to a plain `string` this file stops type-checking.
    setExportHtml(sanitizeHtml('<p>canonical</p>'))
    const root = document.createElement('div')
    patchPreviewContent(root, getExportHtml())
    expect(root.querySelector('p')?.textContent).toBe('canonical')
  })

  it('round-trips the mermaid slots the HTML was parsed from (ADR 0019)', () => {
    // The preview no longer bakes diagrams into the string, so the complete bake needs the
    // SOURCES next to the HTML — see ADR 0019.
    expect(getExportMermaidSlots()).toEqual([])
    const slots = [{ slot: 0, code: 'graph TD;A-->B', hash: 'h1' }]
    setExportMermaidSlots(slots)
    expect(getExportMermaidSlots()).toBe(slots)
  })
})
