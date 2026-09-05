import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Document } from '../types'
import { computeDirty, displayTitle, markdownExtOf, stripMarkdownExt } from '../lib/utils'
import { useUIStore } from '../store/ui'

export function useLocalDocument(
  doc: Document | null | undefined,
  _activeDocumentId: string | null,
) {
  const [localContent, setLocalContent] = useState('')
  // The title draft is kept in DISPLAY form (`notes.md`, extension included) so the
  // title bar can simply render it — see the dirty computation below.
  const [localTitle, setLocalTitle] = useState('')
  // Latest title draft, for use inside stable callbacks (handleContentChange must
  // stay identity-stable for the editor, so it cannot close over `localTitle`).
  const localTitleRef = useRef('')
  useEffect(() => {
    localTitleRef.current = localTitle
  }, [localTitle])
  const [editingTitle, setEditingTitle] = useState(false)
  const [dirty, setDirtyState] = useState(false)

  // The most recent "saved" content/title baseline, used to compute the dirty state
  const savedContentRef = useRef('')
  const savedTitleRef = useRef('')
  // The current document id, used to distinguish "switching documents" from "refreshing the same document's content"
  const prevIdRef = useRef<string | null>(null)
  // Set by the switch branch (layout effect) so the refresh effect below can skip
  // the same pass instead of repeating it — notably re-issuing setDirty(false),
  // which would push another global store update for no reason.
  const justSwitchedRef = useRef(false)
  // The encoding currently applied to the document (used to detect a "manual encoding switch" event)
  const appliedEncodingRef = useRef<string | undefined>(undefined)
  // Draft title as it was when the current rename edit started, so Escape restores it.
  const titleBeforeEditRef = useRef('')
  // The latest dirty flag, for use inside effects (avoids capturing a stale value in the closure).
  // Updated in an effect (not during render) so react-hooks/refs stays happy.
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  })
  // Original line ending: inferred from the authoritative content (disk); on save we
  // restore the editor-normalized LF back to it, so a CRLF file isn't rewritten to LF when edited
  // (CodeMirror internally uses \n as the line separator).
  const eolRef = useRef<'\r\n' | '\n'>('\n')

  // Switching to a different document: always overwrite the local draft with the
  // authoritative content (disk).
  //
  // This runs as a LAYOUT effect, not a plain effect, so the new content is
  // committed before the browser paints. This hook's state necessarily lags the
  // query data by one commit; with useEffect the panes would paint a frame still
  // holding the PREVIOUS document's text right after the loading overlay lifts.
  // Keeping the switch here means EditorPane never renders new-id/old-content.
  useLayoutEffect(() => {
    if (!doc) return
    if (doc.id === prevIdRef.current) return
    prevIdRef.current = doc.id
    appliedEncodingRef.current = doc.encoding
    const title = displayTitle(doc)
    eolRef.current = doc.content.includes('\r\n') ? '\r\n' : '\n'
    setLocalContent(doc.content)
    setLocalTitle(title)
    savedContentRef.current = doc.content
    savedTitleRef.current = title
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
    justSwitchedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id])

  useEffect(() => {
    if (!doc) return
    // A document switch was just handled by the layout effect above: everything
    // this effect would do has already been done.
    if (justSwitchedRef.current) {
      justSwitchedRef.current = false
      return
    }
    // The same document's authoritative content changed (save / reload / reopen / import):
    // if the user has unsaved changes, don't overwrite the local draft; just update the "saved"
    // baseline for later comparison. But if the refreshed on-disk content matches the saved
    // baseline (e.g. an import-many transaction refreshed updated_at while the bytes are
    // unchanged), there is genuinely nothing dirty — clear the dirty flag.
    const title = displayTitle(doc)
    if (dirtyRef.current) {
      if (doc.content === savedContentRef.current && title === savedTitleRef.current) {
        setDirtyState(false)
        useUIStore.getState().setDirty(false)
      }
      savedContentRef.current = doc.content
      savedTitleRef.current = title
      return
    }
    eolRef.current = doc.content.includes('\r\n') ? '\r\n' : '\n'
    setLocalContent(doc.content)
    setLocalTitle(title)
    savedContentRef.current = doc.content
    savedTitleRef.current = title
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
    const title = displayTitle(doc)
    appliedEncodingRef.current = doc.encoding
    setLocalContent(doc.content)
    setLocalTitle(title)
    savedContentRef.current = doc.content
    savedTitleRef.current = title
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [doc?.id, doc?.encoding, doc?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trust the on-disk file's own line ending (async, overriding the synchronous inference above):
  // the on-disk content may have been rewritten by an older version, so disk is the source of
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

  // Whether the draft differs from the last saved baseline in EITHER the content or
  // the title. The two are compared independently: a rename that has not been written
  // to disk yet must survive an unrelated content edit (and vice versa), otherwise the
  // second edit would silently drop the first one's unsaved state.
  const computeDraftDirty = useCallback(
    (content: string, title: string) =>
      computeDirty(content, savedContentRef.current) ||
      stripMarkdownExt(title.trim()) !== stripMarkdownExt(savedTitleRef.current.trim()),
    [],
  )

  // Content change: only update the local draft and mark dirty; no longer auto-write to disk
  const handleContentChange = useCallback(
    (newContent: string) => {
      setLocalContent(newContent)
      setDirty(computeDraftDirty(newContent, localTitleRef.current))
    },
    [setDirty, computeDraftDirty],
  )

  // Re-attach the extension the file currently has when the user typed only the base
  // name: typing `notes` for `notes.markdown` is not a rename. Keeps the draft in
  // display form so the title bar never loses (or invents) an extension.
  const normalizeTitle = useCallback((value: string, currentName: string): string => {
    const base = stripMarkdownExt(value.trim())
    return base ? base + (markdownExtOf(currentName) || '.md') : ''
  }, [])

  // Enter the rename edit, remembering the draft so Escape can restore it exactly —
  // including a rename that was already committed to the draft but not yet saved.
  const startTitleEdit = useCallback(() => {
    titleBeforeEditRef.current = localTitleRef.current
    setEditingTitle(true)
  }, [])

  const cancelTitleEdit = useCallback(() => {
    setLocalTitle(titleBeforeEditRef.current)
    setEditingTitle(false)
  }, [])

  // Title editing finished: adopt the new name into the draft so the title bar shows
  // it immediately (no Save needed to see it), and mark the document dirty. The actual
  // rename is still only written to disk by Save / Save As.
  const handleTitleSave = useCallback(() => {
    setEditingTitle(false)
    const normalized = normalizeTitle(localTitle, savedTitleRef.current)
    if (!normalized) {
      // Blank name: fall back to the saved one. Only the title is reverted — content
      // dirtiness is recomputed so an abandoned rename cannot hide unsaved edits.
      setLocalTitle(savedTitleRef.current)
      setDirty(computeDraftDirty(localContent, savedTitleRef.current))
      return
    }
    setLocalTitle(normalized)
    setDirty(computeDraftDirty(localContent, normalized))
  }, [localTitle, localContent, setDirty, computeDraftDirty, normalizeTitle])

  // Called after Save / Save As / Reload succeeds: update the "saved" baseline to the latest content/title.
  // `title` must be in DISPLAY form (see displayTitle) — the same form the draft uses.
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
    startTitleEdit,
    cancelTitleEdit,
    handleContentChange,
    handleTitleSave,
    dirty,
    markSaved,
    toDiskFormat,
    getEol,
  }
}
