// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createDocumentStore,
  listDocuments,
  getAllDocuments,
  getDocumentById,
  getDocumentByFilePath,
  upsertDocument,
  updateDocument,
  deleteDocument,
  setEncoding,
  purgeUnsavedDrafts,
  newId,
  isInFolder,
  type Document,
} from './documentStore'

// The store is a module-level singleton, so every test starts from a clean slate.
// These tests drive the *real* store: the IPC-level tests (ipc/documents.test.ts)
// mock it out, so this file is what actually pins its semantics.
beforeEach(() => {
  createDocumentStore()
})

function doc(over: Partial<Document> = {}): Document {
  return {
    id: 'id-1',
    title: 'Doc',
    folderPath: '/notes',
    filePath: '/notes/a.md',
    content: 'body',
    wordCount: 1,
    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('documentStore — basics', () => {
  it('starts empty', () => {
    expect(getAllDocuments()).toEqual([])
    expect(listDocuments()).toEqual([])
  })

  it('upserts and reads back a document by id', () => {
    upsertDocument(doc({ id: 'a', title: 'A' }))
    expect(getDocumentById('a')?.title).toBe('A')
  })

  it('upsert stores a copy, so later mutation of the caller object is not reflected', () => {
    const input = doc({ id: 'a', title: 'Original' })
    upsertDocument(input)
    input.title = 'Mutated'
    expect(getDocumentById('a')?.title).toBe('Original')
  })

  it('upsert replaces an existing document with the same id', () => {
    upsertDocument(doc({ id: 'a', title: 'First' }))
    upsertDocument(doc({ id: 'a', title: 'Second' }))
    expect(getAllDocuments()).toHaveLength(1)
    expect(getDocumentById('a')?.title).toBe('Second')
  })

  it('returns null for an unknown id', () => {
    expect(getDocumentById('nope')).toBeNull()
  })

  it('finds a document by its file path', () => {
    upsertDocument(doc({ id: 'a', filePath: '/notes/a.md' }))
    expect(getDocumentByFilePath('/notes/a.md')?.id).toBe('a')
  })

  it('returns null when no document has that file path', () => {
    upsertDocument(doc({ id: 'a', filePath: '/notes/a.md' }))
    expect(getDocumentByFilePath('/notes/missing.md')).toBeNull()
  })

  it('createDocumentStore wipes everything', () => {
    upsertDocument(doc({ id: 'a' }))
    upsertDocument(doc({ id: 'b' }))
    createDocumentStore()
    expect(getAllDocuments()).toEqual([])
  })

  it('newId returns unique values', () => {
    expect(newId()).not.toBe(newId())
  })
})

describe('documentStore — update / delete', () => {
  it('applies a partial update and returns the new document', () => {
    upsertDocument(doc({ id: 'a', title: 'Before' }))
    const updated = updateDocument('a', { title: 'After' })
    expect(updated?.title).toBe('After')
    expect(getDocumentById('a')?.title).toBe('After')
  })

  it('cannot change the id via an update', () => {
    upsertDocument(doc({ id: 'a' }))
    // `id` is stripped from the incoming partial and re-applied from the key.
    const updated = updateDocument('a', { id: 'hacked' } as Partial<Document>)
    expect(updated?.id).toBe('a')
    expect(getDocumentById('a')).not.toBeNull()
    expect(getDocumentById('hacked')).toBeNull()
  })

  it('returns null when updating an unknown id', () => {
    expect(updateDocument('nope', { title: 'x' })).toBeNull()
  })

  it('deletes a document and reports whether it existed', () => {
    upsertDocument(doc({ id: 'a' }))
    expect(deleteDocument('a')).toBe(true)
    expect(deleteDocument('a')).toBe(false)
    expect(getDocumentById('a')).toBeNull()
  })

  it('sets the encoding and its confidence', () => {
    upsertDocument(doc({ id: 'a', encoding: 'utf-8', encodingConfidence: 1 }))
    setEncoding('a', 'gbk', 0.42)
    const d = getDocumentById('a')
    expect(d?.encoding).toBe('gbk')
    expect(d?.encodingConfidence).toBe(0.42)
  })

  it('ignores setEncoding for an unknown id', () => {
    expect(() => setEncoding('nope', 'gbk', 1)).not.toThrow()
    expect(getDocumentById('nope')).toBeNull()
  })
})

describe('documentStore — listDocuments', () => {
  it('returns everything when no folder is given, newest first', () => {
    upsertDocument(doc({ id: 'old', updatedAt: 1 }))
    upsertDocument(doc({ id: 'new', updatedAt: 3 }))
    upsertDocument(doc({ id: 'mid', updatedAt: 2 }))
    expect(listDocuments().map((d) => d.id)).toEqual(['new', 'mid', 'old'])
  })

  it('treats an empty folder as "no filter"', () => {
    upsertDocument(doc({ id: 'a' }))
    expect(listDocuments('')).toHaveLength(1)
  })

  it('keeps only documents inside the folder, including sub-folders', () => {
    upsertDocument(doc({ id: 'in', filePath: '/notes/a.md' }))
    upsertDocument(doc({ id: 'sub', filePath: '/notes/deep/b.md' }))
    upsertDocument(doc({ id: 'out', filePath: '/other/c.md' }))
    expect(
      listDocuments('/notes')
        .map((d) => d.id)
        .sort(),
    ).toEqual(['in', 'sub'])
  })

  it('always includes memory-only drafts, whatever the folder', () => {
    upsertDocument(doc({ id: 'draft', filePath: '', memoryOnly: true }))
    upsertDocument(doc({ id: 'other', filePath: '/other/c.md' }))
    expect(listDocuments('/notes').map((d) => d.id)).toEqual(['draft'])
  })

  it('excludes a draft saved outside the folder once it has a file', () => {
    upsertDocument(doc({ id: 'draft', filePath: '/elsewhere/d.md', memoryOnly: false }))
    expect(listDocuments('/notes')).toEqual([])
  })

  it('does not treat a sibling folder sharing a prefix as inside', () => {
    upsertDocument(doc({ id: 'sib', filePath: '/notes-other/a.md' }))
    expect(listDocuments('/notes')).toEqual([])
  })
})

describe('documentStore — purgeUnsavedDrafts', () => {
  it('removes documents with an empty file path and counts them', () => {
    upsertDocument(doc({ id: 'draft', filePath: '' }))
    upsertDocument(doc({ id: 'saved', filePath: '/notes/a.md' }))
    expect(purgeUnsavedDrafts()).toBe(1)
    expect(getDocumentById('draft')).toBeNull()
    expect(getDocumentById('saved')).not.toBeNull()
  })

  it('also removes a draft whose file path is null (legacy fixtures)', () => {
    upsertDocument(doc({ id: 'legacy', filePath: null as unknown as string }))
    expect(purgeUnsavedDrafts()).toBe(1)
  })

  it('reports zero when there is nothing to purge', () => {
    upsertDocument(doc({ id: 'saved', filePath: '/notes/a.md' }))
    expect(purgeUnsavedDrafts()).toBe(0)
    expect(getAllDocuments()).toHaveLength(1)
  })
})

// isInFolder is re-exported from here by several callers; the shared semantics are
// pinned in folderMatch.ts's own tests, this only guards the re-export itself.
describe('documentStore — isInFolder re-export', () => {
  it('matches a file directly inside the folder', () => {
    expect(isInFolder('/notes/a.md', '/notes')).toBe(true)
  })

  it('rejects a file with no directory component', () => {
    // Covers the "no separator in the path" branch: the directory resolves to ''.
    expect(isInFolder('a.md', '/notes')).toBe(false)
  })
})
