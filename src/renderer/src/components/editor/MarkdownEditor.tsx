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

export function MarkdownEditor({ content, onChange, autoFocus, editable = true, docId }: MarkdownEditorProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isInternalChange = useRef(false)
  // 当前已同步的文档 id：用于区分“回声（同一文档的滞后内容）”与“真正切换文档”。
  // 切换文档时必须强制应用新内容，即便 isInternalChange 因刚编辑过而为 true。
  const currentDocIdRef = useRef<string | null | undefined>(undefined)
  // 程序化写入（切换文档 / 外部同步）进行中：期间屏蔽 updateListener 的回声，
  // 否则会把规范化后的编辑器内容误当作用户输入回写，导致切换文档后误报“未保存”。
  const isApplyingExternal = useRef(false)
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
          if (update.docChanged && !isApplyingExternal.current) {
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

    // 注册到同步滚动控制器：源码窗格作为 "editor" 一侧，提供 getView 供行号映射（§4.7）
    scrollSync.register('editor', view.scrollDOM, { getView: () => viewRef.current })

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
      scrollSync.unregister('editor')
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

  // Sync external content changes (e.g., doc switch / reload / external file change)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // 文档切换：强制应用新内容，绕过回声防护（否则刚编辑过的 isInternalChange
    // 会让本 effect 提前 return，导致编辑器停留在上一个文档，而预览已切换）。
    const isDocSwitch = docId !== currentDocIdRef.current
    currentDocIdRef.current = docId
    if (isInternalChange.current && !isDocSwitch) {
      isInternalChange.current = false
      return
    }
    isInternalChange.current = false
    const currentContent = view.state.doc.toString()
    if (currentContent !== content) {
      // 标记为程序化写入：屏蔽本帧 updateListener 的回声，避免切换文档后
      // 400ms 防抖把规范化后的内容误判为“未保存改动”（脏标记）。
      isApplyingExternal.current = true
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
        selection: { anchor: 0 }
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
