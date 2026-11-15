import React, { useEffect, useRef, useCallback, useState } from 'react'
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorState, Compartment, Transaction } from '@codemirror/state'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  selectAll,
  undoDepth,
  redoDepth,
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { useEditorHistory } from '../../store/editorHistory'
import { useUIStore } from '../../store/ui'
import { languages } from '@codemirror/language-data'
import {
  searchKeymap,
  search,
  openSearchPanel,
  findNext,
  findPrevious,
  replaceAll,
} from '@codemirror/search'
import { createFindPanel } from './createFindPanel'
import { autocompletion } from '@codemirror/autocomplete'
import {
  Undo2,
  Redo2,
  Scissors,
  Copy,
  ClipboardPaste,
  List,
  Bold,
  Italic,
  Code,
  Link2,
  ExternalLink,
  FileText,
  FolderOpen,
} from 'lucide-react'
import { debounce, formatShortcut } from '../../lib/utils'
import { FORMAT_SHORTCUTS } from '../../lib/format-shortcuts'
import { scrollSync } from '../../lib/scrollSync'
import { useT } from '../../i18n'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../ui/context-menu'

/**
 * One EDITING SESSION per document. It owns the debounce AND the right to write: a keystroke
 * may only be committed while it was applied to exactly the text this session wrote, so a
 * session that outlives its document can never write that document's text into the next one.
 * `preview()` is the 400ms debounce that ONLY refreshes the preview/React state. Correctness
 * state (dirty, registry, draftRef) is committed synchronously on the keystroke via
 * `onImmediateChange`, never through this debounce.
 *
 * Two teardown paths, and the difference matters:
 *   - `abort()` — a DOCUMENT SWITCH: drop the pending refresh, because that text belongs to the
 *     document being left.
 *   - `flushAndAbort()` — the editor unmounts while the SAME document stays open (switching to
 *     preview-only): land the pending refresh first, or the preview would show stale text.
 * This is the "land pending work before teardown" rule from ADR-0033.
 */
interface EditingSession {
  /**
   * WRITE OWNERSHIP: the text this session last wrote into the view. A keystroke is committed
   * only when it was applied to exactly this text — that is how a session knows the view still
   * holds ITS document. A document switch rotates the session BEFORE the view is updated, so a
   * keystroke landing in that window still carries the PREVIOUS document's text; committing it
   * would write that text into the new document's draft.
   * `null` = this session owns nothing yet (it was just rotated, or the view was never written).
   */
  owned: string | null
  /** The 400ms debounce that only refreshes the preview/React state. */
  preview: (text: string) => void
  /** Drop the pending refresh: that text belongs to the document being left. */
  abort: () => void
  /** Land the pending refresh first, then invalidate: the same document stays open. */
  flushAndAbort: () => void
}

function createSession(emitPreview: (text: string) => void): EditingSession {
  const controller = new AbortController()
  let pending: string | null = null
  const fire = (text: string) => {
    pending = null
    if (controller.signal.aborted) return
    emitPreview(text)
  }
  const debounced = debounce(fire, 400)
  const invalidate = () => {
    debounced.cancel()
    pending = null
    controller.abort()
  }
  return {
    owned: null,
    preview: (text) => {
      pending = text
      debounced(text)
    },
    abort: invalidate,
    flushAndAbort: () => {
      // A session that was already aborted (the store rotated it on a document switch) has
      // nothing to land: its text belongs to the document being left.
      const text = pending
      const wasAborted = controller.signal.aborted
      invalidate()
      if (text !== null && !wasAborted) emitPreview(text)
    },
  }
}

interface MarkdownEditorProps {
  content: string
  /** Debounced (400ms) preview/React-state refresh. Never carries correctness state. */
  onChange: (content: string) => void
  /** Fires on the keystroke frame: commit dirty + registry + draftRef before any switch. */
  onImmediateChange?: (content: string) => void
  autoFocus?: boolean
  editable?: boolean
  docId?: string | null
  filePath?: string | null
  // Resident search jump (Phase 4): when set, the editor selects + scrolls to this saved-content
  // offset once the document content has loaded. Provided by EditorPane from the store's
  // pendingMatch; the editor calls onConsumeSelection after applying it so the store can clear it.
  selectionOffset?: { from: number; to: number } | null
  onConsumeSelection?: () => void
}

export function MarkdownEditor({
  content,
  onChange,
  onImmediateChange,
  autoFocus,
  editable = true,
  docId,
  filePath = null,
  selectionOffset = null,
  onConsumeSelection,
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
  // The undo history lives in a compartment so a document switch can DROP the field and add it
  // back: CodeMirror then re-creates the StateField with an empty history. There is no public
  // `clearHistory` API, and re-creating the EditorView per document would bring back the
  // "can't type after switching files" focus bug this persistent view exists to avoid.
  const historyCompartment = useRef(new Compartment())
  // Mirror of the current editable flag, read lazily when the find panel is (re)created
  // so the panel always reflects the latest edit mode rather than the mount-time value.
  const editableRef = useRef(editable)
  // Mirror of the current find/replace open intent, read lazily when the find panel is (re)created
  // so it opens in the right mode: `markdown:find` (Ctrl/Cmd+F) → find-only, `markdown:replace`
  // (Ctrl/Cmd+H) → find+replace. Keeps Ctrl+F a pure "find" (VS Code parity) instead of always
  // showing the replace field just because the editor happens to be editable.
  const replaceIntentRef = useRef(false)

  // Registered by the find panel on mount; CodeMirror's `panel.update` forwards the editor
  // view through it so the k/n match counter recomputes on every selection change. Kept in a
  // ref so the (mount-time) update listener always reads the latest registered callback.
  const [panelUpdate, setPanelUpdate] = useState<((v: EditorView) => void) | null>(null)
  const panelUpdateRef = useRef<((v: EditorView) => void) | null>(null)
  useEffect(() => {
    panelUpdateRef.current = panelUpdate
  }, [panelUpdate])

  // Mount-time listeners must not capture a stale parent render (advanced-event-handler-refs),
  // and must never re-subscribe when a callback identity changes. Both callbacks live in refs.
  const onChangeRef = useRef(onChange)
  const onImmediateChangeRef = useRef(onImmediateChange)
  useEffect(() => {
    onChangeRef.current = onChange
    onImmediateChangeRef.current = onImmediateChange
  }, [onChange, onImmediateChange])

  // One session per document. Created at mount, aborted + replaced on every switch. Reading a
  // ref is deliberately confined to effects/handlers: `react-hooks/refs` forbids it during render.
  const sessionRef = useRef<EditingSession | null>(null)
  const emitPreview = useCallback((text: string) => onChangeRef.current(text), [])

  // Focus the editor's content DOM directly and retry across a few animation frames as a
  // best-effort to make the editor typeable immediately. A real pointerdown into the editor
  // (handlePointerDown) remains the reliable fallback for gaining OS focus.
  const requestFocus = useCallback(() => {
    const view = viewRef.current
    // The EditorView is created synchronously in the mount effect, so the ref is always
    // populated by the time this callback can be invoked; the guard only narrows its
    // nullable type and is therefore not reachable in tests.
    /* v8 ignore next -- defensive: the EditorView is created synchronously in the mount effect, so view is never null when this callback runs */
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
  // EditorState.readOnly locked contenteditable='true' yet typing was hard-blocked (the exact
  // "toolbar says edit mode but you cannot type" symptom after switching files). Reconfiguring them
  // together makes a split state impossible.
  const readOnlyFacets = (
    isEditable: boolean,
  ): Parameters<typeof editableCompartment.current.of>[0] => [
    EditorState.readOnly.of(!isEditable),
    EditorView.editable.of(isEditable),
  ]

  // ── Right-click (context) menu: state, command snapshot & commands ──
  // The menu is rendered inside this component so it holds the viewRef directly no
  // forwardRef command exposure is needed
  const { t } = useT()

  type CmdState = {
    canUndo: boolean
    canRedo: boolean
    hasSelection: boolean
    docEmpty: boolean
    linkUrl: string | null
  }
  const initialCmd: CmdState = {
    canUndo: false,
    canRedo: false,
    hasSelection: false,
    docEmpty: false,
    linkUrl: null,
  }
  const [cmd, setCmd] = useState<CmdState>(initialCmd)
  // CM selection cached on pointerdown (capture phase), used to restore the selection if
  // the contextmenu event clears it (G4, / )
  const cachedSelRef = useRef<{ from: number; to: number } | null>(null)

  const cacheSelection = useCallback(() => {
    const view = viewRef.current
    /* v8 ignore next -- defensive: a pointerdown reaches this handler only via the mounted editor DOM, so the view is never null */
    if (!view) return
    const s = view.state.selection.main
    cachedSelRef.current = { from: s.from, to: s.to }
  }, [])

  // Effective selection: if the live selection was cleared by the contextmenu but we
  // cached a real one on pointerdown, restore the cached range so cut/copy/format act on it.
  const getSelectionRange = (): { from: number; to: number } => {
    const view = viewRef.current
    /* v8 ignore next -- defensive: only called from menu item handlers, which require a mounted editor */
    if (!view) return { from: 0, to: 0 }
    const live = view.state.selection.main
    const cached = cachedSelRef.current
    if (live.empty && cached && cached.from !== cached.to) return cached
    return { from: live.from, to: live.to }
  }

  // Detect a markdown link under the cursor so "Open Link in Browser" can enable
  // Regex over the cursor's line is the pragmatic fallback (: " ]( URL ")
  const linkUrlAt = (state: EditorState, pos: number): string | null => {
    const line = state.doc.lineAt(pos)
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index
      const end = start + m[0].length
      if (pos >= start && pos <= end) return m[1]
    }
    return null
  }

  // Snapshot command availability when the menu opens
  const snapshotCommands = (open: boolean) => {
    if (!open) return
    const view = viewRef.current
    /* v8 ignore next -- defensive: the menu only opens over the mounted editor */
    if (!view) return
    const state = view.state
    const sel = getSelectionRange()
    setCmd({
      canUndo: undoDepth(state) > 0,
      canRedo: redoDepth(state) > 0,
      hasSelection: sel.from !== sel.to,
      docEmpty: state.doc.length === 0,
      linkUrl: linkUrlAt(state, state.selection.main.head),
    })
  }

  const doUndo = () => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    undo(v)
    v.focus()
  }
  const doRedo = () => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    redo(v)
    v.focus()
  }
  const doSelectAll = () => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    selectAll(v)
    v.focus()
  }

  const doCut = async () => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    const { from, to } = getSelectionRange()
    const text = v.state.sliceDoc(from, to)
    await window.api.clipboard.writeText(text)
    // A zero-length range is a no-op replace, so this is safe for cut-with-no-selection too.
    v.dispatch({ changes: { from, to, insert: '' } })
    v.focus()
  }
  const doCopy = async () => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    const { from, to } = getSelectionRange()
    await window.api.clipboard.writeText(v.state.sliceDoc(from, to))
    v.focus()
  }
  const doPaste = async () => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    const text = await navigator.clipboard.readText()
    const { from, to } = getSelectionRange()
    v.dispatch({ changes: { from, to, insert: text } })
    v.focus()
  }
  // Toggle a marker pair around the selection; with no selection, insert the markers with
  // the cursor parked between them (: never insert the literal 'text' placeholder)
  const wrap = (before: string, after: string) => {
    const v = viewRef.current
    /* v8 ignore next -- defensive: only invoked from a menu item over the mounted editor */
    if (!v) return
    const { from, to } = getSelectionRange()
    const sel = v.state.sliceDoc(from, to)
    v.dispatch({
      changes: { from, to, insert: before + sel + after },
      selection: { anchor: from + before.length, head: from + before.length + sel.length },
    })
    v.focus()
  }
  const openLinkInBrowser = () => {
    // Safe: this item is disabled when cmd.linkUrl is null
    void window.api.app.openExternal(cmd.linkUrl!)
  }
  const copyFilePath = () => {
    // Safe: this item is disabled when filePath is null.
    void window.api.clipboard.writeText(filePath as string)
  }
  const showInFolder = () => {
    // Safe: this item is disabled when filePath is null. .catch swallows a failure
    // (e.g. an externally-deleted file) so it fails gracefully
    void Promise.resolve(window.api.app.showInFolder(filePath as string)).catch(() => {})
  }

  useEffect(() => {
    // The container div is rendered unconditionally, so the ref is always attached once
    // this mount effect runs; the guard only narrows its nullable type.
    /* v8 ignore next -- defensive: the container div is rendered unconditionally, so the ref is always attached when this effect runs */
    if (!containerRef.current) return

    // Session lifecycle is driven by the STORE, synchronously: `selectDocument` commits the new
    // activeDocumentId before React renders, so subscribing here closes the window between
    // "store switched" and "effect cleanup ran" that a pending 400ms timer could otherwise fire in.
    // docId is used here ONLY as a switch signal, never as a write target or callback argument.
    sessionRef.current = createSession(emitPreview)
    const unsubscribe = useUIStore.subscribe((state, prev) => {
      if (state.activeDocumentId === prev.activeDocumentId) return
      // A real document switch: the pending preview text belongs to the OLD document, drop it.
      sessionRef.current?.abort()
      // The fresh session owns NOTHING yet: the view still holds the old document's text until
      // the sync effect writes the new one, so a keystroke in that window is not committed.
      sessionRef.current = createSession(emitPreview)
    })

    const startState = EditorState.create({
      doc: content,
      extensions: [
        // Read-only / edit mode, reconfigurable via the editable compartment.
        editableCompartment.current.of(readOnlyFacets(editable)),
        historyCompartment.current.of(history()),
        highlightActiveLine(),
        // Draw the selection even when the editor is NOT focused. A resident-search hit sets
        // the selection programmatically (the sidebar keeps focus), so without this the
        // "jump to hit" would place the cursor where the user cannot see it.
        drawSelection(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          // Ctrl/Cmd+F is deliberately NOT bound here: it must have a SINGLE owner — the guarded
          // window-level handler in EditorPane. CodeMirror's own Mod-f binding opens the find panel
          // whenever the editor happens to hold focus, which includes while a modal overlay that
          // does not trap focus (the command palette is a plain overlay) is open. That is exactly
          // what the modal guard exists to prevent, so leaving Mod-f here would silently bypass it.
          // Behaviour is unchanged: the window handler opens the same panel via `markdown:find`.
          ...searchKeymap.filter((binding) => binding.key !== 'Mod-f'),
          // Editor-scoped find navigation: F3 / Ctrl|Cmd+G step through matches even when
          // the editor content (not the panel) has focus. The search extension already binds
          // these inside the "search-panel" scope, so this only fills the gap for the content
          // scope.
          { key: 'F3', run: findNext, shift: findPrevious },
          { key: 'Mod-g', run: findNext, shift: findPrevious },
          indentWithTab,
        ]),
        // In-editor find panel. `createPanel` mounts our shared FindWidget (top-anchored, VS Code
        // style) instead of CodeMirror's native panel. Opening is owned by the window-level
        // Ctrl/Cmd+F handler in EditorPane (Mod-f is filtered out of searchKeymap above), and any
        // external "markdown:find" event (e.g. the editor toolbar button) opens it too.
        search({
          createPanel: (view) =>
            createFindPanel(view, {
              editable: editableRef.current,
              registerUpdate: setPanelUpdate,
              // Read at creation time so the first open matches the shortcut that triggered it.
              openInReplaceMode: replaceIntentRef.current,
            }),
          top: true,
        }),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: true,
        }),
        autocompletion(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isApplyingExternal.current) {
            const session = sessionRef.current
            const text = update.state.doc.toString()
            // WRITE OWNERSHIP: a keystroke may only be committed while it was applied to exactly
            // the text this session wrote. A document switch rotates the session BEFORE the view
            // is updated, so a keystroke landing in that window still carries the PREVIOUS
            // document's text — committing it would write that text into the new document's
            // draft, which is exactly the "Ctrl+Z replays the previous file" bug (ADR-0033).
            if (session !== null && session.owned === update.startState.doc.toString()) {
              isInternalChange.current = true
              // Correctness state lands on THIS frame; the 400ms debounce only refreshes the
              // preview. A switch that happens in between can no longer lose the keystroke.
              onImmediateChangeRef.current?.(text)
              session.preview(text)
              session.owned = text
            }
          }
          // Refresh the find panel's k/n counter when the cursor moves between matches.
          if (update.selectionSet) panelUpdateRef.current?.(view)
          // Publish live undo/redo availability so the editor pane bar's buttons track it in real
          // time (ADR-0024 §10 trade-off 47). Only doc changes alter history depth, so gate there.
          if (update.docChanged) {
            useEditorHistory.getState().update({
              canUndo: undoDepth(update.state) > 0,
              canRedo: redoDepth(update.state) > 0,
            })
          }
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
          },
          '.cm-content': {
            // Follow the theme variable instead of naming fonts that are never shipped —
            // `.cm-editor { font-family: … !important }` cannot reach this child element anyway.
            fontFamily: 'var(--font-mono)',
            lineHeight: '1.7',
            caretColor: 'var(--color-accent)',
            color: 'var(--color-text-primary)',
            padding: '24px 0',
          },
          '.cm-line': { padding: '0 32px' },
          '.cm-activeLine': {
            backgroundColor: 'color-mix(in srgb, var(--color-accent) 4%, transparent)',
          },
          '.cm-gutters': { display: 'none' },
          '.cm-selectionBackground': {
            backgroundColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent) !important',
          },
          '&.cm-focused .cm-selectionBackground': {
            backgroundColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent) !important',
          },
          '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
        }),
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    })

    viewRef.current = view

    // The session owns the view from here on: a keystroke may be committed only while it builds
    // on exactly this text. Read it from the VIEW, not from the `content` prop — CodeMirror
    // normalizes line endings, so the view's text can differ from the prop.
    if (sessionRef.current) sessionRef.current.owned = view.state.doc.toString()

    // A fresh CodeMirror instance starts with an EMPTY history. The editor pane bar's undo/redo
    // buttons read their disabled state from the editorHistory store, which outlives this view
    // (the editor pane is unmounted in preview-only mode), so clear it here — otherwise the
    // buttons would stay enabled while `undo()` had nothing to undo.
    useEditorHistory.getState().reset()

    // Register with the scroll-sync controller: the source pane acts as the "editor" side
    // (ratio mapping, no getView needed).
    scrollSync.register('editor', view.scrollDOM)

    // Focus on mount when already editable (e.g. a freshly opened editable doc, or a document
    // switch that lands in edit mode). Without this, a key-remounted editor has no focus and
    // especially under Electron clicking into it may fail to focus, so typing appears dead until
    // the window loses and regains focus. autoFocus covers the explicit "open and focus" case.
    // window.focus() first helps Electron give the renderer process OS focus (a bare view.focus()
    // fired during a programmatic remount, with no user gesture, is silently dropped otherwise).
    if (autoFocus || editable) {
      requestFocus()
      view.dispatch({
        selection: { anchor: view.state.doc.length },
      })
    }

    // Handle toolbar / shortcut insert events. All THREE formatting entry points — the right-click
    // menu, the toolbar button and the keyboard shortcut — share ONE implementation (`wrap`), so an
    // action behaves identically however it is triggered. With nothing selected the markers are
    // inserted with the caret parked between them (the mainstream Markdown-editor behaviour:
    // Obsidian / VS Code / Typora) and never a literal 'text' placeholder. `wrap` reads the live
    // editor selection, so it is the single source of truth for "format the selection". The
    // `editable` guard is the read-only safety net — the menu item is disabled, but the toolbar
    // button and the keyboard shortcut still dispatch and must no-op in read-only mode.
    const handleInsert = (e: Event) => {
      if (!editable) return
      const { before, after } = (e as CustomEvent<{ before: string; after: string }>).detail
      wrap(before, after)
    }

    document.addEventListener('markdown:insert', handleInsert)

    // Select All routed from the native menu (menu:select-all IPC → selectAllRouter → this
    // event). Must use CodeMirror's OWN selectAll command: the DOM-level select-all the old
    // menu role performed desynced CM's internal selection from the DOM (the "Ctrl+A only
    // selects content before the cursor" bug). The CM command selects the whole document
    // and keeps both selections in sync.
    const handleSelectAll = () => {
      const v = viewRef.current
      /* v8 ignore next -- defensive: the event is only dispatched while an editor is mounted */
      if (!v) return
      selectAll(v)
      v.focus()
    }
    document.addEventListener('markdown:select-all', handleSelectAll)

    // Open the in-editor find panel on request from the editor toolbar button. CodeMirror's
    // own Mod-f binding already opens it when the editor has focus; this listener covers the
    // case where the button is clicked without editor focus.
    const handleFind = () => {
      const v = viewRef.current
      /* v8 ignore next -- defensive: the event is only dispatched while an editor is mounted */
      if (!v) return
      // Ctrl/Cmd+F intent: find-only (VS Code parity). The panel reads this on (re)create and the
      // editor find panel collapses its replace row in response.
      replaceIntentRef.current = false
      openSearchPanel(v)
      // Focus of the query field is owned by `EditorFindPanel`'s mount effect, which runs after
      // React commits the (asynchronously-rendered) panel so the `[main-field]` input actually
      // exists. CodeMirror itself refocuses it on a *subsequent* `openSearchPanel` (when the panel
      // already lives in the view state), so nothing more is needed here for repeat Ctrl+F.
    }
    document.addEventListener('markdown:find', handleFind)

    // Replace entry point (Ctrl+H / toolbar button). The CodeMirror search panel already
    // includes a replace field, so we reuse the same panel as find — but opened in replace mode.
    const handleReplace = () => {
      const v = viewRef.current
      /* v8 ignore next -- defensive: the event is only dispatched while an editor is mounted */
      if (!v) return
      replaceIntentRef.current = true
      openSearchPanel(v)
    }
    document.addEventListener('markdown:replace', handleReplace)

    // Replace-all entry point (Shift+Ctrl+H). Reuses the search state's current query.
    const handleReplaceAll = () => {
      const v = viewRef.current
      /* v8 ignore next -- defensive: the event is only dispatched while an editor is mounted */
      if (!v) return
      replaceAll(v)
    }
    document.addEventListener('markdown:replaceAll', handleReplaceAll)

    // Undo/redo entry points for the editor pane bar (ADR-0024 §10 trade-off 47). They call the
    // same CodeMirror commands the right-click menu uses, so both surfaces share one history.
    const handleUndo = () => doUndo()
    const handleRedo = () => doRedo()
    document.addEventListener('markdown:undo', handleUndo)
    document.addEventListener('markdown:redo', handleRedo)

    return () => {
      document.removeEventListener('markdown:insert', handleInsert)
      document.removeEventListener('markdown:select-all', handleSelectAll)
      document.removeEventListener('markdown:find', handleFind)
      document.removeEventListener('markdown:replace', handleReplace)
      document.removeEventListener('markdown:replaceAll', handleReplaceAll)
      document.removeEventListener('markdown:undo', handleUndo)
      document.removeEventListener('markdown:redo', handleRedo)
      scrollSync.unregister('editor')
      unsubscribe()
      // Unmount keeps the same document open (e.g. view-preview hides the editor), so any
      // pending preview refresh must be flushed rather than discarded. A document switch/close
      // has already rotated the session (the store subscription above), so that session has
      // nothing pending to flush.
      sessionRef.current?.flushAndAbort()
      sessionRef.current = null
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When toggling read-only / edit mode, reconfigure the editor dynamically (no rebuild,
  // preserving cursor and scroll). BOTH facets are reconfigured together so they can never split.
  useEffect(() => {
    const view = viewRef.current
    // The view is always created by the mount effect above before this effect
    // can run (it only re-runs on `editable` changes, which require a mounted
    // editor), so `view` is never null here defensive guard only
    /* v8 ignore next -- defensive: the mount effect always creates the view before this effect runs, so view is never null */
    if (!view) return
    editableRef.current = editable
    view.dispatch({ effects: editableCompartment.current.reconfigure(readOnlyFacets(editable)) })
    // Entering edit mode: take focus so the user can type immediately without first clicking into
    // the editor. This is the real fix for "switched to edit mode but couldn't type" the editor
    // was editable (facet=true) but simply had no focus, and under Electron a click didn't always
    // re-focus it. Leaving edit mode must NOT steal focus, so only focus when becoming editable.
    if (editable) {
      // Under Electron a programmatic view.focus() (fired from a store change, e.g. clicking the
      // edit-mode button) is dropped unless the renderer already has OS focus that's why typing
      // only worked after Alt-Tab away and back. requestFocus() focuses the content DOM directly
      // (with a few animation-frame retries) so typing works immediately when entering edit mode.
      requestFocus()
    }
  }, [editable, requestFocus])

  // Sync external content changes (e.g., doc switch / reload / external file change)
  useEffect(() => {
    const view = viewRef.current
    // This effect runs after mount, by which point the EditorView has been created and
    // stored in the ref; the guard only narrows its nullable type.
    /* v8 ignore next -- defensive: the view ref is always populated after mount when this effect runs */
    if (!view) return
    // Document switch: force-apply the new content, bypassing the echo guard (otherwise a
    // recently-edited isInternalChange would make this effect return early, leaving the editor
    // on the previous document while the preview has already switched).
    const isDocSwitch = docId !== currentDocIdRef.current
    currentDocIdRef.current = docId
    if (isDocSwitch) {
      // The store subscription above normally rotates the session first; abort again here as a
      // no-op guard for prop-driven switches (unit tests / an id change without a store update).
      sessionRef.current?.abort()
      sessionRef.current = createSession(emitPreview)
    }
    if (isInternalChange.current && !isDocSwitch) {
      isInternalChange.current = false
      return
    }
    isInternalChange.current = false

    // A document switch must always re-apply the current editable state, otherwise the editor
    // can stay stuck in the previous document's read-only/edit mode after switching files
    // (editable is a global flag that the switch itself doesn't change, so its dedicated effect
    // may not re-run leaving the editor out of sync with the toolbar). Reconfigure BOTH facets
    // together so read-only and editable can never diverge.
    if (isDocSwitch) {
      // NOTE on EditorState.readOnly: it is an advisory facet. CodeMirror's own
      // code only reads it to disable its built-in commands / input handling and
      // to set aria-readonly it does NOT block a programmatic view.dispatch
      // (verified against @codemirror/view: the only read of state.readOutside of
      // input & command paths is contentAttrs["aria-readonly"]). The content write
      // below would therefore succeed with the lock ON.
      //
      // We still reconfigure to the real state explicitly, because the switch also
      // has to settle the DOM: editable is a global flag the switch itself does not
      // change, so its dedicated effect may not re-run, and leaving the previous
      // document's state in place would desync the editor from the toolbar.
      view.dispatch({ effects: editableCompartment.current.reconfigure(readOnlyFacets(true)) })
    }

    const currentContent = view.state.doc.toString()
    // A resident-search jump applies once the real (non-empty) content is present; while the
    // document is still loading (content === '') we only fill the editor, then the follow-up
    // run (real content arrives) performs the jump.
    const jumpOff = selectionOffset && content !== '' ? selectionOffset : null
    // A jump offset is computed against the SAVED document text. While the editor is mid-switch
    // it can still be showing the PREVIOUS document, and an unsaved buffer can differ from the
    // saved text — so the offsets may fall outside the content being written. Dispatching an
    // out-of-range selection makes CodeMirror throw "Selection points outside of document" and
    // crash the pane. Jump only when the range is valid for THIS content; otherwise leave the
    // offset pending so the follow-up run (once the real content lands) applies it.
    const jumpTarget =
      jumpOff && jumpOff.from >= 0 && jumpOff.from <= jumpOff.to && jumpOff.to <= content.length
        ? jumpOff
        : null
    const replacingContent = currentContent !== content
    if (isDocSwitch || replacingContent || jumpTarget) {
      // A programmatic content load starts with an EMPTY undo history — whether it is a
      // document switch, a reload from disk, or an external file change on the SAME doc id.
      // Dropping the history field and adding it back in two separate transactions makes
      // CodeMirror re-create the StateField; otherwise old edits remain undoable and Ctrl+Z
      // past the new text's beginning replaces the whole document with stale content.
      //
      // Keeping the history for a SAME-doc reload was considered and rejected: CodeMirror's
      // history events map through the document, so once the buffer was replaced wholesale the
      // older events can no longer be mapped back (measured: the second Ctrl+Z after such a
      // reload does nothing at all). VS Code does the same on a model-wide replacement — its
      // `TextModel.setValue` swaps the buffer and then destroys the edit history
      // (`this._commandManager.clear()`, textModel.ts:530-531) — so a reload ending with an
      // empty undo stack is the mainstream behaviour, not a MarkFlow-only shortcut. Clearing
      // also gives the user a predictable state: after a reload, Ctrl+Z has nothing to undo.
      // A selection-only jump (replacingContent === false) keeps the user's history.
      if (isDocSwitch || replacingContent) {
        view.dispatch({ effects: historyCompartment.current.reconfigure([]) })
        view.dispatch({ effects: historyCompartment.current.reconfigure(history()) })
      }
      // Mark as a programmatic write: suppress this frame's updateListener echo so the 400ms
      // debounce doesn't mistake the normalized content for "unsaved changes" (dirty flag)
      // after a document switch.
      isApplyingExternal.current = true
      try {
        view.dispatch({
          changes: { from: 0, to: currentContent.length, insert: content },
          selection: jumpTarget ? { anchor: jumpTarget.from, head: jumpTarget.to } : { anchor: 0 },
          scrollIntoView: true,
          // Loading a document is never an undoable edit. `isolateHistory` is NOT enough:
          // it only prevents event MERGING, and the old `.of(undefined)` value was falsy,
          // so the full-document replacement itself stayed in the history and Ctrl+Z
          // could walk back into the previous file.
          annotations: Transaction.addToHistory.of(false),
        })
      } finally {
        isApplyingExternal.current = false
      }
      // The jump offset is consumed only once the cursor was actually placed + scrolled into
      // view. An offset that did not fit the content yet (mid-switch / drifted buffer) is left
      // pending so a later run with the correct content applies it instead of dropping it.
      if (jumpTarget) onConsumeSelection?.()
    }

    // The session owns the view again: from here on a keystroke that builds on the text the
    // view holds is committed to THIS document. Without this, a session that was rotated by the
    // store subscription would keep owning nothing and the editor would stop committing.
    if (sessionRef.current) sessionRef.current.owned = view.state.doc.toString()

    // After a document switch, apply the REAL read-only/edit state (the write above happened with
    // readOnly temporarily OFF so it wouldn't be rejected). Skipped when not a switch because the
    // dedicated editable effect already handles toggle changes.
    if (isDocSwitch) {
      view.dispatch({ effects: editableCompartment.current.reconfigure(readOnlyFacets(editable)) })
    }
  }, [content, docId, editable, selectionOffset, onConsumeSelection, emitPreview])

  // Focus the editor on a REAL user gesture (pointerdown into the editor area). This runs
  // synchronously inside the browser's user-activation context, so the browser WILL grant the
  // webContents OS focus and dispatch a focus event making CodeMirror's hasFocus=true and
  // keystrokes reach the editor. A programmatic focus() (e.g. from a store change / setTimeout) is
  // dropped by Windows' foreground-lock, which is exactly why typing only worked after Alt-Tab.
  const handlePointerDown = useCallback(() => {
    const view = viewRef.current
    // A pointerdown can only reach this handler through the mounted editor DOM, so the
    // ref is always populated; the guard only narrows its nullable type.
    /* v8 ignore next -- defensive: a pointerdown can only reach this handler via the mounted editor DOM, so view is never null */
    if (!view) return
    try {
      view.focus()
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <ContextMenu onOpenChange={snapshotCommands}>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerDownCapture={cacheSelection}
          className="h-full overflow-auto editor-content"
          style={{ background: 'var(--color-surface)' }}
        >
          {/* The CodeMirror view is appended here by the mount effect. */}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-testid="me-undo"
          shortcut={formatShortcut('⌘Z')}
          disabled={!editable || !cmd.canUndo}
          onClick={doUndo}
        >
          <Undo2 size={13} /> {t('ctx.undo')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-redo"
          shortcut={formatShortcut('⌘⇧Z')}
          disabled={!editable || !cmd.canRedo}
          onClick={doRedo}
        >
          <Redo2 size={13} /> {t('ctx.redo')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-cut"
          shortcut={formatShortcut('⌘X')}
          disabled={!editable || !cmd.hasSelection}
          onClick={() => void doCut()}
        >
          <Scissors size={13} /> {t('ctx.cut')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-copy"
          shortcut={formatShortcut('⌘C')}
          disabled={!cmd.hasSelection}
          onClick={() => void doCopy()}
        >
          <Copy size={13} /> {t('ctx.copy')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-paste"
          shortcut={formatShortcut('⌘V')}
          disabled={!editable}
          onClick={() => void doPaste()}
        >
          <ClipboardPaste size={13} /> {t('ctx.paste')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-select-all"
          shortcut={formatShortcut('⌘A')}
          disabled={cmd.docEmpty}
          onClick={doSelectAll}
        >
          <List size={13} /> {t('ctx.selectAll')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* The four formatting items DO advertise their shortcut: ADR-0032 wired ⌘B / ⌘I / ⌘E / ⌘K
            to the editor, so the labels are truthful now (they were withheld while those keys
            belonged to other commands — "no false promises"). The glyphs and the wrapped markup
            come from the shared format-shortcut table, the same source the toolbar reads.
            All four formatting paths — this right-click menu via `wrap`, the toolbar button and the
            keyboard shortcut via `markdown:insert` → `handleInsert` — share ONE implementation, so an
            action behaves identically however it is triggered. With nothing selected the markers are
            inserted with the caret parked between them (the mainstream Markdown-editor behaviour)
            and never a literal 'text' placeholder. */}
        <ContextMenuItem
          data-testid="me-bold"
          shortcut={formatShortcut(FORMAT_SHORTCUTS.bold.glyph)}
          disabled={!editable}
          onClick={() => wrap(FORMAT_SHORTCUTS.bold.before, FORMAT_SHORTCUTS.bold.after)}
        >
          <Bold size={13} /> {t('editor.fmt.bold')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-italic"
          shortcut={formatShortcut(FORMAT_SHORTCUTS.italic.glyph)}
          disabled={!editable}
          onClick={() => wrap(FORMAT_SHORTCUTS.italic.before, FORMAT_SHORTCUTS.italic.after)}
        >
          <Italic size={13} /> {t('editor.fmt.italic')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-inline-code"
          shortcut={formatShortcut(FORMAT_SHORTCUTS.code.glyph)}
          disabled={!editable}
          onClick={() => wrap(FORMAT_SHORTCUTS.code.before, FORMAT_SHORTCUTS.code.after)}
        >
          <Code size={13} /> {t('editor.fmt.code')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-link"
          shortcut={formatShortcut(FORMAT_SHORTCUTS.link.glyph)}
          disabled={!editable}
          onClick={() => wrap(FORMAT_SHORTCUTS.link.before, FORMAT_SHORTCUTS.link.after)}
        >
          <Link2 size={13} /> {t('editor.fmt.link')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-open-link-in-browser"
          disabled={!cmd.linkUrl}
          onClick={openLinkInBrowser}
        >
          <ExternalLink size={13} /> {t('ctx.openLinkInBrowser')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="me-copy-path" disabled={!filePath} onClick={copyFilePath}>
          <FileText size={13} /> {t('editor.copyFullPath')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="me-show-in-folder"
          disabled={!filePath}
          onClick={showInFolder}
        >
          <FolderOpen size={13} /> {t('editor.showInFolder')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
