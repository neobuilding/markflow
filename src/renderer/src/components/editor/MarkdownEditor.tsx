import React, { useEffect, useRef, useMemo } from 'react'
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { searchKeymap } from '@codemirror/search'
import { autocompletion } from '@codemirror/autocomplete'
import { debounce } from '../../lib/utils'

interface MarkdownEditorProps {
  content: string
  onChange: (content: string) => void
  autoFocus?: boolean
  editable?: boolean
}

export function MarkdownEditor({ content, onChange, autoFocus, editable = true }: MarkdownEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isInternalChange = useRef(false)
  const editableCompartment = useRef(new Compartment())

  const debouncedOnChange = useMemo(
    () => debounce((val: string) => onChange(val), 400),
    [onChange]
  )

  useEffect(() => {
    if (!containerRef.current) return

    const startState = EditorState.create({
      doc: content,
      extensions: [
        // 只读模式：禁止编辑与输入（可被 editable 变化动态重配置）
        editableCompartment.current.of([
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable)
        ]),
        history(),
        highlightActiveLine(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab
        ]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: true
        }),
        autocompletion(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            isInternalChange.current = true
            debouncedOnChange(update.state.doc.toString())
          }
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px'
          },
          '.cm-content': {
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineHeight: '1.7',
            caretColor: '#5e6ad2',
            color: '#1a1a1a',
            padding: '24px 0'
          },
          '.cm-line': { padding: '0 32px' },
          '.cm-activeLine': { backgroundColor: 'rgba(94,106,210,0.04)' },
          '.cm-gutters': { display: 'none' },
          '.cm-selectionBackground': { backgroundColor: 'rgba(94,106,210,0.2) !important' },
          '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(94,106,210,0.2) !important' },
          '.cm-cursor': { borderLeftColor: '#5e6ad2' }
        }),
        EditorView.lineWrapping
      ]
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current
    })

    viewRef.current = view

    if (autoFocus) {
      view.focus()
      view.dispatch({
        selection: { anchor: view.state.doc.length }
      })
    }

    // Handle toolbar insert events
    const handleInsert = (e: Event) => {
      if (!editable) return // 只读模式下忽略格式化插入
      const { before, after } = (e as CustomEvent<{ before: string; after: string }>).detail
      const v = viewRef.current
      if (!v) return
      const sel = v.state.selection.main
      const selectedText = v.state.sliceDoc(sel.from, sel.to)
      const insertion = before + (selectedText || 'text') + after
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertion },
        selection: { anchor: sel.from + before.length, head: sel.from + before.length + (selectedText || 'text').length }
      })
      v.focus()
    }

    document.addEventListener('markdown:insert', handleInsert)

    return () => {
      document.removeEventListener('markdown:insert', handleInsert)
      view.destroy()
      viewRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换只读 / 编辑模式时，动态重配置编辑器（不重建实例，保留光标与滚动）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable)
      ])
    })
  }, [editable])

  // Sync external content changes (e.g., doc switch)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (isInternalChange.current) {
      isInternalChange.current = false
      return
    }
    const currentContent = view.state.doc.toString()
    if (currentContent !== content) {
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
        selection: { anchor: 0 }
      })
    }
  }, [content])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto editor-content"
      style={{ background: 'var(--color-surface)' }}
    />
  )
}
