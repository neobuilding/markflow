import React, { useEffect, useRef, useMemo, useCallback } from 'react'
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { searchKeymap } from '@codemirror/search'
import { autocompletion } from '@codemirror/autocomplete'
import { debounce } from '../../lib/utils'
import { scrollSync } from '../../lib/scrollSync'

interface MarkdownEditorProps {
  content: string
  onChange: (content: string) => void
  autoFocus?: boolean
  editable?: boolean
  docId?: string | null
}

export function MarkdownEditor({
  content,
  onChange,
  autoFocus,
  editable = true,
  docId,
}: MarkdownEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isInternalChange = useRef(false)
  // The doc id currently synced: used to tell apart an "echo" (lagging content of the same
  // document) from a genuine document switch.
  // On a document switch we must force-apply the new content even if isInternalChange is true
  // from just having edited.
  const currentDocIdRef = useRef<string | null | undefined>(undefined)
  // A programmatic write (document switch / external sync) is in progress: suppress the
  // updateListener echo during it, otherwise the normalized editor content would be mistaken
  // for user input and written back, causing a false "unsaved" flag after switching documents.
  const isApplyingExternal = useRef(false)
  const editableCompartment = useRef(new Compartment())

  const debouncedOnChange = useMemo(() => debounce((val: string) => onChange(val), 400), [onChange])

  // Focus the editor's content DOM directly and retry across a few animation frames as a
  // best-effort to make the editor typeable immediately. A real pointerdown into the editor
  // (handlePointerDown) remains the reliable fallback for gaining OS focus.
  const requestFocus = useCallback(() => {
    const view = viewRef.current
    if (!view) return

    const focusDom = () => {
      try {
        view.contentDOM.focus()
      } catch {
        /* ignore */
      }
      try {
        view.focus()
      } catch {
        /* ignore */
      }
    }

    // Focus the content DOM immediately, then retry on a few animation frames.
    focusDom()
    let frames = 0
    const tick = () => {
      if (typeof document !== 'undefined' && document.hasFocus() && view.hasFocus) return
      focusDom()
      frames += 1
      if (frames < 5) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [])

  // Build the read-only/edit facet array. We use BOTH facets together:
  //   - EditorState.readOnly: hard lock that blocks any document change (user OR programmatic)
  //   - EditorView.editable:  controls the DOM contenteditable attribute (user input only)
  // CRITICAL: both must ALWAYS be set to the SAME value in the SAME place. The original bug was that
  // they lived in separate effects, so toggling edit flipped EditorView.editable but left
  // EditorState.readOnly locked — contenteditable='true' yet typing was hard-blocked (the exact
  // "toolbar says edit mode but you cannot type" symptom after switching files). Reconfiguring them
  // together makes a split state impossible.
  const readOnlyFacets = (
    isEditable: boolean,
  ): Parameters<typeof editableCompartment.current.of>[0] => [
    EditorState.readOnly.of(!isEditable),
    EditorView.editable.of(isEditable),
  ]

  useEffect(() => {
    if (!containerRef.current) return

    const startState = EditorState.create({
      doc: content,
      extensions: [
        // Read-only / edit mode, reconfigurable via the editable compartment.
        editableCompartment.current.of(readOnlyFacets(editable)),
        history(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: true,
        }),
        autocompletion(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isApplyingExternal.current) {
            isInternalChange.current = true
            debouncedOnChange(update.state.doc.toString())
          }
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
          },
          '.cm-content': {
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineHeight: '1.7',
            caretColor: '#5e6ad2',
            color: '#1a1a1a',
            padding: '24px 0',
          },
          '.cm-line': { padding: '0 32px' },
          '.cm-activeLine': { backgroundColor: 'rgba(94,106,210,0.04)' },
          '.cm-gutters': { display: 'none' },
          '.cm-selectionBackground': { backgroundColor: 'rgba(94,106,210,0.2) !important' },
          '&.cm-focused .cm-selectionBackground': {
            backgroundColor: 'rgba(94,106,210,0.2) !important',
          },
          '.cm-cursor': { borderLeftColor: '#5e6ad2' },
        }),
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    })

    viewRef.current = view

    // Register with the scroll-sync controller: the source pane acts as the "editor" side
    // (ratio mapping, no getView needed).
    scrollSync.register('editor', view.scrollDOM)

    // Focus on mount when already editable (e.g. a freshly opened editable doc, or a document
    // switch that lands in edit mode). Without this, a key-remounted editor has no focus and —
    // especially under Electron — clicking into it may fail to focus, so typing appears dead until
    // the window loses and regains focus. autoFocus covers the explicit "open and focus" case.
    // window.focus() first helps Electron give the renderer process OS focus (a bare view.focus()
    // fired during a programmatic remount, with no user gesture, is silently dropped otherwise).
    if (autoFocus || editable) {
      requestFocus()
      view.dispatch({
        selection: { anchor: view.state.doc.length },
      })
    }

    // Handle toolbar insert events
    const handleInsert = (e: Event) => {
      if (!editable) return // ignore formatting inserts in read-only mode
      const { before, after } = (e as CustomEvent<{ before: string; after: string }>).detail
      const v = viewRef.current
      if (!v) return
      const sel = v.state.selection.main
      const selectedText = v.state.sliceDoc(sel.from, sel.to)
      const insertion = before + (selectedText || 'text') + after
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertion },
        selection: {
          anchor: sel.from + before.length,
          head: sel.from + before.length + (selectedText || 'text').length,
        },
      })
      v.focus()
    }

    document.addEventListener('markdown:insert', handleInsert)

    return () => {
      document.removeEventListener('markdown:insert', handleInsert)
      scrollSync.unregister('editor')
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When toggling read-only / edit mode, reconfigure the editor dynamically (no rebuild,
  // preserving cursor and scroll). BOTH facets are reconfigured together so they can never split.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: editableCompartment.current.reconfigure(readOnlyFacets(editable)) })
    // Entering edit mode: take focus so the user can type immediately without first clicking into
    // the editor. This is the real fix for "switched to edit mode but couldn't type" — the editor
    // was editable (facet=true) but simply had no focus, and under Electron a click didn't always
    // re-focus it. Leaving edit mode must NOT steal focus, so only focus when becoming editable.
    if (editable) {
      // Under Electron a programmatic view.focus() (fired from a store change, e.g. clicking the
      // edit-mode button) is dropped unless the renderer already has OS focus — that's why typing
      // only worked after Alt-Tab away and back. requestFocus() focuses the content DOM directly
      // (with a few animation-frame retries) so typing works immediately when entering edit mode.
      requestFocus()
    }
  }, [editable, requestFocus])

  // Sync external content changes (e.g., doc switch / reload / external file change)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // Document switch: force-apply the new content, bypassing the echo guard (otherwise a
    // recently-edited isInternalChange would make this effect return early, leaving the editor
    // on the previous document while the preview has already switched).
    const isDocSwitch = docId !== currentDocIdRef.current
    currentDocIdRef.current = docId
    if (isInternalChange.current && !isDocSwitch) {
      isInternalChange.current = false
      return
    }
    isInternalChange.current = false

    // A document switch must always re-apply the current editable state, otherwise the editor
    // can stay stuck in the previous document's read-only/edit mode after switching files
    // (editable is a global flag that the switch itself doesn't change, so its dedicated effect
    // may not re-run — leaving the editor out of sync with the toolbar). Reconfigure BOTH facets
    // together so read-only and editable can never diverge.
    if (isDocSwitch) {
      // On a doc switch the target is read-only (the store resets editable to false), so the hard
      // readOnly lock would be ON. But we still must write the new content programmatically, and
      // EditorState.readOnly blocks programmatic dispatches too. So: first flip readOnly OFF (and
      // editable ON) to allow the write below, then re-apply the real read-only state afterwards.
      view.dispatch({ effects: editableCompartment.current.reconfigure(readOnlyFacets(true)) })
    }

    const currentContent = view.state.doc.toString()
    if (isDocSwitch || currentContent !== content) {
      // Mark as a programmatic write: suppress this frame's updateListener echo so the 400ms
      // debounce doesn't mistake the normalized content for "unsaved changes" (dirty flag)
      // after a document switch.
      isApplyingExternal.current = true
      try {
        const tr = {
          changes: { from: 0, to: currentContent.length, insert: content },
          selection: { anchor: 0 },
          scrollIntoView: true,
          // Isolate undo history at the document boundary so edits to the previous document can't
          // be undone from the new one (we keep a single persistent EditorView instead of remounting
          // per document, which is what fixed the "can't type after switching files" focus bug).
          annotations: isDocSwitch ? (isolateHistory as any).of(undefined) : undefined,
        }
        view.dispatch(tr as Parameters<typeof view.dispatch>[0])
      } finally {
        isApplyingExternal.current = false
      }
    }

    // After a document switch, apply the REAL read-only/edit state (the write above happened with
    // readOnly temporarily OFF so it wouldn't be rejected). Skipped when not a switch because the
    // dedicated editable effect already handles toggle changes.
    if (isDocSwitch) {
      view.dispatch({ effects: editableCompartment.current.reconfigure(readOnlyFacets(editable)) })
    }
  }, [content, docId, editable])

  // Focus the editor on a REAL user gesture (pointerdown into the editor area). This runs
  // synchronously inside the browser's user-activation context, so the browser WILL grant the
  // webContents OS focus and dispatch a focus event — making CodeMirror's hasFocus=true and
  // keystrokes reach the editor. A programmatic focus() (e.g. from a store change / setTimeout) is
  // dropped by Windows' foreground-lock, which is exactly why typing only worked after Alt-Tab.
  const handlePointerDown = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    try {
      view.focus()
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      className="h-full overflow-auto editor-content"
      style={{ background: 'var(--color-surface)' }}
    />
  )
}
