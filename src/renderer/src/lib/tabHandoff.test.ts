import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTabHandoff } from './tabHandoff'
import { useTabsStore } from '../store/tabs'
import { useUIStore } from '../store/ui'
import { seedHistory } from '../store/tabHistory'

function setupApi(opts: { doc?: unknown; root?: string | null } = {}) {
  const doc =
    'doc' in opts
      ? opts.doc
      : {
          id: 'doc-a',
          filePath: '/root/a.md',
          content: '# A\r\n',
        }
  ;(window as unknown as { api: unknown }).api = {
    documents: {
      get: vi.fn(async () => doc),
      getWorkspaceRoot: vi.fn(async () => (opts.root === undefined ? '/root' : opts.root)),
    },
  }
}

describe('buildTabHandoff (ADR-0040)', () => {
  beforeEach(() => {
    useTabsStore.getState().reset()
    useUIStore.setState({ unsavedBuffers: {} })
  })

  it('returns null for an unknown tab or missing document', async () => {
    setupApi()
    expect(await buildTabHandoff('missing')).toBeNull()
    useTabsStore.getState().openTab('doc-a', { tabId: 'a' })
    setupApi({ doc: null })
    expect(await buildTabHandoff('a')).toBeNull()
  })

  it('captures a complete handoff including draft title, eol and history', async () => {
    setupApi()
    useTabsStore.getState().openTab('doc-a', { tabId: 'a', title: 'a.md', isNewUnsaved: true })
    seedHistory('a', [{ path: '/root/a.md' }], 0)
    useUIStore.getState().reportUnsavedBuffer('doc-a', 'draft', 'a*.md')
    const handoff = await buildTabHandoff('a')
    expect(handoff).toEqual({
      tabId: 'a',
      documentId: 'doc-a',
      filePath: '/root/a.md',
      content: 'draft',
      title: 'a*.md',
      external: false,
      isNewUnsaved: true,
      eol: '\r\n',
      history: [{ path: '/root/a.md' }],
      cursor: 0,
    })
  })

  it('marks a file outside the root external and handles a null root', async () => {
    setupApi({ root: '/other' })
    useTabsStore.getState().openTab('doc-a', { tabId: 'a', title: 'a.md' })
    expect((await buildTabHandoff('a'))?.external).toBe(true)
    setupApi({ root: null })
    expect((await buildTabHandoff('a'))?.external).toBe(false)
  })

  it('treats a memory-only document with no path as non-external', async () => {
    setupApi({ doc: { id: 'doc-a', filePath: '', content: '' } })
    useTabsStore.getState().openTab('doc-a', { tabId: 'a', title: 'Untitled' })
    expect((await buildTabHandoff('a'))?.external).toBe(false)
  })

  it('uses disk content when no draft exists and defaults eol to LF', async () => {
    setupApi({ doc: { id: 'doc-a', filePath: '/root/a.md', content: '# A' } })
    useTabsStore.getState().openTab('doc-a', { tabId: 'a', title: 'a.md' })
    const handoff = await buildTabHandoff('a')
    expect(handoff?.content).toBeNull()
    expect(handoff?.eol).toBe('\n')
  })
})
