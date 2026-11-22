// documentStore.ts in-memory single source of truth for documents
// Documents live in a Map keyed by id; disk I/O and encoding detection stay in the
// IPC handlers (documents.ts) which call into this store after reading/writing files.
import { randomUUID } from 'node:crypto'
import { isInFolder } from './folderMatch'
import { currentStore } from './windowContext'

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
  // false when absent
  memoryOnly?: boolean
  // True when the file this document points at no longer exists on disk, because it
  // was deleted or moved outside the app.
  //
  // The record is deliberately KEPT rather than dropped: like VS Code, which leaves a
  // struck-through tab open, the document stays editable so an accidental deletion can
  // still be saved straight back to disk. A rename is repaired by re-pointing this same
  // record at the new path (see syncAddedFile), which is what lets the open editor and
  // its unsaved draft survive it. The record only disappears when the user closes the
  // document, or on restart (this store is in-memory and rebuilt from disk).
  // Optional for the same backward-compat reason; absent means "not missing".
  missing?: boolean
  // True for a Markdown file opened from OUTSIDE the current workspace root (via the preview
  // link / drag-drop three-way choice "open here, keep workspace"). It has a real filePath, is
  // watched by a dedicated single-file watcher, and is deliberately excluded from the folder
  // tree, search and replace scope (relToRoot returns null for it). Cleared by a workspace
  // switch together with the rest of the store. Optional; absent means "inside the workspace".
  external?: boolean
}

// Re-export so existing importers of `documentStore.isInFolder` keep working.
export { isInFolder }

// The single in-memory map. A module-level singleton seeded once at app start.

export function createDocumentStore(): void {
  // The store starts empty and is populated by the IPC handlers as documents are
  // created/imported. From then on it is kept in sync with the filesystem by the
  // recursive folder watcher (model/folderWatcher.ts), which folds in files that
  // appear or disappear under the folders the user opened.
  currentStore().clear()
}

// List documents, optionally filtered to those inside `folderPath` (the renderer's
// workspaceRoot, an absolute path). Memory-only drafts (no filePath) are always
// included regardless of folder, matching the old "return all + renderer filters"
// behavior. Filtering uses isInFolder so sub-folders are included
export function listDocuments(folderPath?: string): Document[] {
  const all = [...currentStore().values()]
  const target = folderPath && folderPath !== '' ? folderPath : undefined
  const filtered = target
    ? all.filter((d) => d.memoryOnly === true || isInFolder(d.filePath, target))
    : all
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getAllDocuments(): Document[] {
  return [...currentStore().values()]
}

export function getDocumentById(id: string): Document | null {
  return currentStore().get(id) ?? null
}

export function getDocumentByFilePath(filePath: string): Document | null {
  for (const d of currentStore().values()) {
    if (d.filePath === filePath) return d
  }
  return null
}

// Insert or replace a document by id. Returns the stored document.
export function upsertDocument(doc: Document): Document {
  currentStore().set(doc.id, { ...doc })
  return currentStore().get(doc.id) as Document
}

export function updateDocument(
  id: string,
  partial: Partial<Omit<Document, 'id'>>,
): Document | null {
  const existing = currentStore().get(id)
  if (!existing) return null
  const next: Document = { ...existing, ...partial, id }
  currentStore().set(id, next)
  return next
}

export function deleteDocument(id: string): boolean {
  return currentStore().delete(id)
}

export function setEncoding(id: string, encoding: string, confidence: number): void {
  const existing = currentStore().get(id)
  if (!existing) return
  currentStore().set(id, { ...existing, encoding, encodingConfidence: confidence })
}

// Remove unsaved (memory-only) drafts those with an empty filePath and return
// how many were purged. Mirrors the old `DELETE FROM documents WHERE file_path = ''`.
export function purgeUnsavedDrafts(): number {
  let removed = 0
  for (const [id, d] of currentStore()) {
    if (d.filePath === '' || d.filePath === null) {
      currentStore().delete(id)
      removed++
    }
  }
  return removed
}

export function newId(): string {
  return randomUUID()
}
