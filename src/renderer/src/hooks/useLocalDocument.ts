import { useState, useCallback, useEffect, useRef } from 'react'
import type { Document } from '../types'
import { computeDirty } from '../lib/utils'
import { useUIStore } from '../store/ui'

export function useLocalDocument(
  doc: Document | null | undefined,
  _activeDocumentId: string | null,
) {
  const [localContent, setLocalContent] = useState('')
  const [localTitle, setLocalTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [dirty, setDirtyState] = useState(false)

  // The most recent "saved" content/title baseline, used to compute the dirty state
  const savedContentRef = useRef('')
  const savedTitleRef = useRef('')
  // The current document id, used to distinguish "switching documents" from "refreshing the same document's content"
  const prevIdRef = useRef<string | null>(null)
  // The encoding currently applied to the document (used to detect a "manual encoding switch" event)
  const appliedEncodingRef = useRef<string | undefined>(undefined)
  // The latest dirty flag, for use inside effects (avoids capturing a stale value in the closure).
  // Updated in an effect (not during render) so react-hooks/refs stays happy.
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  })
  // Original line ending: inferred from the authoritative content (disk/database); on save we
  // restore the editor-normalized LF back to it, so a CRLF file isn't rewritten to LF when edited
  // (CodeMirror internally uses \n as the line separator).
  const eolRef = useRef<'\r\n' | '\n'>('\n')

  useEffect(() => {
    if (!doc) return
    // Switching to a different document: always overwrite the local draft with the authoritative content (disk/database)
    if (doc.id !== prevIdRef.current) {
      prevIdRef.current = doc.id
      appliedEncodingRef.current = doc.encoding
      eolRef.current = doc.content.includes('\r\n') ? '\r\n' : '\n'
      setLocalContent(doc.content)
      setLocalTitle(doc.title)
      savedContentRef.current = doc.content
      savedTitleRef.current = doc.title
      setDirtyState(false)
      useUIStore.getState().setDirty(false)
      return
    }
    // The same document's authoritative content changed (save / reload / reopen / import):
    // if the user has unsaved changes, don't overwrite the local draft; just update the "saved"
    // baseline for later comparison. But if the refreshed on-disk content matches the saved
    // baseline (e.g. an import-many transaction refreshed updated_at while the bytes are
    // unchanged), there is genuinely nothing dirty — clear the dirty flag.
    if (dirtyRef.current) {
      if (doc.content === savedContentRef.current && doc.title === savedTitleRef.current) {
        setDirtyState(false)
        useUIStore.getState().setDirty(false)
      }
      savedContentRef.current = doc.content
      savedTitleRef.current = doc.title
      return
    }
    eolRef.current = doc.content.includes('\r\n') ? '\r\n' : '\n'
    setLocalContent(doc.content)
    setLocalTitle(doc.title)
    savedContentRef.current = doc.content
    savedTitleRef.current = doc.title
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [doc?.id, doc?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Manual encoding switch (same document, encoding field changed): overwrite the local draft
  // with the re-decoded content, clear dirty and refresh the "saved" baseline (disk bytes are
  // unchanged, so we must not report a false dirty state).
  useEffect(() => {
    if (!doc) return
    // The main effect (above) always runs first and updates prevIdRef on a document switch,
    // so by the time this effect runs the id already matches — no separate id check is needed.
    if (doc.encoding === appliedEncodingRef.current) return
    appliedEncodingRef.current = doc.encoding
    setLocalContent(doc.content)
    setLocalTitle(doc.title)
    savedContentRef.current = doc.content
    savedTitleRef.current = doc.title
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [doc?.id, doc?.encoding, doc?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trust the on-disk file's own line ending (async, overriding the synchronous inference above):
  // the database content may have been rewritten by an older version, so disk is the source of
  // truth for line endings. Only read the first 64KB, so the cost is negligible.
  useEffect(() => {
    if (!doc?.filePath) return
    let cancelled = false
    window.api.documents
      .eol(doc.filePath)
      .then((eol) => {
        if (!cancelled) eolRef.current = eol
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc?.id, doc?.filePath])

  const setDirty = useCallback((d: boolean) => {
    setDirtyState(d)
    useUIStore.getState().setDirty(d)
  }, [])

  // Before saving, restore the editor-normalized LF back to the document's original line ending,
  // so we don't alter the file's line endings.
  // eol defaults to eolRef (the async result read from disk); it can also be passed explicitly at
  // save time (see EditorPane re-reading disk at save time as the final source of truth, avoiding
  // any dependency on whether the async effect finished).
  const toDiskFormat = useCallback((text: string, eol: '\r\n' | '\n' = eolRef.current): string => {
    if (eol === '\r\n') {
      return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
    }
    return text
  }, [])

  // Return the currently inferred original line ending (fallback if the save-time IPC fails)
  const getEol = useCallback((): '\r\n' | '\n' => eolRef.current, [])

  // Content change: only update the local draft and mark dirty; no longer auto-write to disk
  const handleContentChange = useCallback(
    (newContent: string) => {
      setLocalContent(newContent)
      setDirty(computeDirty(newContent, savedContentRef.current))
    },
    [setDirty],
  )

  // Title editing finished: only mark dirty (the actual rename/write is done by Save / Save As)
  const handleTitleSave = useCallback(() => {
    setEditingTitle(false)
    const trimmed = localTitle.trim()
    if (!trimmed) {
      setLocalTitle(savedTitleRef.current)
      setDirty(false)
      return
    }
    setDirty(trimmed !== savedTitleRef.current)
  }, [localTitle, setDirty])

  // Called after Save / Save As / Reload succeeds: update the "saved" baseline to the latest content/title
  const markSaved = useCallback((content: string, title: string) => {
    savedContentRef.current = content
    savedTitleRef.current = title
    setLocalContent(content)
    setLocalTitle(title)
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [])

  return {
    localContent,
    setLocalContent,
    localTitle,
    setLocalTitle,
    editingTitle,
    setEditingTitle,
    handleContentChange,
    handleTitleSave,
    dirty,
    markSaved,
    toDiskFormat,
    getEol,
  }
}
