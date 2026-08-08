import type { Document } from '../types'
import type { FileTreeNode } from './utils'

// PLAN §6.3 (G2): memory-only (unsaved) documents (filePath === '') must be listed in the sidebar
// under a dedicated "Unsaved drafts" group, even when a folder is open. isInFolder() always returns
// false for empty paths, so they are split out explicitly here instead of via folder matching.

// Documents with no on-disk path are "memory-only" drafts.
export function isMemoryOnly(doc: Document): boolean {
  return !doc.filePath
}

// Split a list of documents into memory-only drafts and folder documents.
export function splitMemoryOnlyDocs(docs: Document[]): {
  memoryOnly: Document[]
  folder: Document[]
} {
  const memoryOnly: Document[] = []
  const folder: Document[] = []
  for (const d of docs) {
    if (isMemoryOnly(d)) memoryOnly.push(d)
    else folder.push(d)
  }
  return { memoryOnly, folder }
}

// Wrap a memory-only document into a tree leaf node so it can be rendered by TreeRow.
export function memoryOnlyLeaf(doc: Document): FileTreeNode {
  return {
    name: doc.title || 'Untitled',
    path: doc.id,
    isFolder: false,
    doc,
    children: [],
  }
}
