import React, { useEffect, useRef, useMemo } from 'react'
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
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

  useEffect(() => {
    if (!containerRef.current) return

    const startState = EditorState.create({
      doc: content,
      extensions: [
        // Read-only mode: disable editing and input (can be reconfigured dynamically via editable)
        editableCompartment.current.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
        ]),
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

    if (autoFocus) {
      view.focus()
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
  // preserving cursor and scroll)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    })
  }, [editable])

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
    const currentContent = view.state.doc.toString()
    if (currentContent !== content) {
      // Mark as a programmatic write: suppress this frame's updateListener echo so the 400ms
      // debounce doesn't mistake the normalized content for "unsaved changes" (dirty flag)
      // after a document switch.
      isApplyingExternal.current = true
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
        selection: { anchor: 0 },
      })
      isApplyingExternal.current = false
    }
  }, [content, docId])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto editor-content"
      style={{ background: 'var(--color-surface)' }}
    />
  )
}
