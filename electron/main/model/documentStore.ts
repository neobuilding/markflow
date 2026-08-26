// documentStore.ts — in-memory single source of truth for documents (replaces the
// better-sqlite3 `documents` table). Phase one of removing the database layer:
// documents live in a Map keyed by id; disk I/O and encoding detection stay in the
// IPC handlers (documents.ts) which call into this store after reading/writing files.
import { randomUUID } from 'node:crypto'
import { isInFolder } from './folderMatch'

export interface Document {
  id: string
  title: string
  folderPath: string
  filePath: string
  content: string
  wordCount: number
  encoding: string
  encodingConfidence: number
  createdAt: number
  updatedAt: number
  // True for pure in-app drafts that have no on-disk file (filePath === '').
  // Optional for backward-compat with hand-built test fixtures; treated as
  // false when absent (plan §2).
  memoryOnly?: boolean
}

// Re-export so existing importers of `documentStore.isInFolder` keep working.
export { isInFolder }

// The single in-memory map. A module-level singleton seeded once at app start.
const docs = new Map<string, Document>()

export function createDocumentStore(): void {
  // Phase one: the store starts empty and is populated by the IPC handlers as
  // documents are created/imported. (Phase two will cold-fill from disk via
  // fsScanner and maintain openFolders; the openFolders set is not needed yet
  // because listDocuments filters by the activeFolder passed from the renderer.)
  docs.clear()
}

// List documents, optionally filtered to those inside `folderPath` (the renderer's
// activeFolder, an absolute path). Memory-only drafts (no filePath) are always
// included regardless of folder, matching the old "return all + renderer filters"
// behavior. Filtering uses isInFolder so sub-folders are included (plan §4).
export function listDocuments(folderPath?: string): Document[] {
  const all = [...docs.values()]
  const target = folderPath && folderPath !== '' ? folderPath : undefined
  const filtered = target
    ? all.filter((d) => d.memoryOnly === true || isInFolder(d.filePath, target))
    : all
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getAllDocuments(): Document[] {
  return [...docs.values()]
}

export function getDocumentById(id: string): Document | null {
  return docs.get(id) ?? null
}

export function getDocumentByFilePath(filePath: string): Document | null {
  for (const d of docs.values()) {
    if (d.filePath === filePath) return d
  }
  return null
}

// Insert or replace a document by id. Returns the stored document.
export function upsertDocument(doc: Document): Document {
  docs.set(doc.id, { ...doc })
  return docs.get(doc.id) as Document
}

export function updateDocument(
  id: string,
  partial: Partial<Omit<Document, 'id'>>,
): Document | null {
  const existing = docs.get(id)
  if (!existing) return null
  const next: Document = { ...existing, ...partial, id }
  docs.set(id, next)
  return next
}

export function deleteDocument(id: string): boolean {
  return docs.delete(id)
}

export function setEncoding(id: string, encoding: string, confidence: number): void {
  const existing = docs.get(id)
  if (!existing) return
  docs.set(id, { ...existing, encoding, encodingConfidence: confidence })
}

// Remove unsaved (memory-only) drafts — those with an empty filePath — and return
// how many were purged. Mirrors the old `DELETE FROM documents WHERE file_path = ''`.
export function purgeUnsavedDrafts(): number {
  let removed = 0
  for (const [id, d] of docs) {
    if (d.filePath === '' || d.filePath === null) {
      docs.delete(id)
      removed++
    }
  }
  return removed
}

export function newId(): string {
  return randomUUID()
}
