import { describe, it, expect } from 'vitest'
import type { Document } from '../types'
import { isMemoryOnly, splitMemoryOnlyDocs, memoryOnlyLeaf } from './sidebarDrafts'

function doc(id: string, filePath: string): Document {
  return {
    id,
    title: `Doc ${id}`,
    folderPath: '',
    filePath,
    content: '',
    wordCount: 0,

    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('sidebarDrafts (PLAN §6.3 G2)', () => {
  it('identifies memory-only documents as those with no filePath', () => {
    expect(isMemoryOnly(doc('a', ''))).toBe(true)
    expect(isMemoryOnly(doc('b', '/x/b.md'))).toBe(false)
  })

  it('splits memory-only drafts from folder documents', () => {
    const docs = [doc('a', ''), doc('b', '/x/b.md'), doc('c', '')]
    const { memoryOnly, folder } = splitMemoryOnlyDocs(docs)
    expect(memoryOnly.map((d) => d.id)).toEqual(['a', 'c'])
    expect(folder.map((d) => d.id)).toEqual(['b'])
  })

  it('wraps a memory-only doc into a tree leaf node', () => {
    const node = memoryOnlyLeaf(doc('a', ''))
    expect(node.isFolder).toBe(false)
    expect(node.path).toBe('a')
    expect(node.doc?.id).toBe('a')
    expect(node.name).toBe('Doc a')
    expect(node.children).toEqual([])
  })

  it('falls back to the "Untitled" label when the draft has an empty title', () => {
    const untitled = { ...doc('a', ''), title: '' }
    const node = memoryOnlyLeaf(untitled)
    // An unnamed draft must still render a stable, non-empty label in the sidebar.
    expect(node.name).toBe('Untitled')
    // The fallback is display-only: identity still comes from the document id.
    expect(node.path).toBe('a')
    expect(node.doc).toBe(untitled)
  })

  it('splits an empty list into two empty buckets', () => {
    expect(splitMemoryOnlyDocs([])).toEqual({ memoryOnly: [], folder: [] })
  })

  it('preserves the original document objects (not copies) when splitting', () => {
    const draft = doc('a', '')
    const saved = doc('b', '/x/b.md')
    const { memoryOnly, folder } = splitMemoryOnlyDocs([draft, saved])
    expect(memoryOnly[0]).toBe(draft)
    expect(folder[0]).toBe(saved)
  })
})
