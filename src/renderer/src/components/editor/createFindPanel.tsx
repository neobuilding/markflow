import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import { EditorFindPanel, type FindPanelUpdate } from './findPanel'

// `search({ createPanel })` adapter: builds the CodeMirror Panel whose DOM hosts a
// React root rendering EditorFindPanel. `top: true` anchors the panel at the top of
// the editor (VS Code style). The root is unmounted on `destroy` to avoid leaks.
//
// It lives apart from `findPanel.tsx` because it exports a non-component function:
// a module that exports both a component and non-components breaks Fast Refresh
// (react-refresh/only-export-components).
export function createFindPanel(
  view: EditorView,
  opts: { editable: boolean; registerUpdate?: (fn: FindPanelUpdate | null) => void } = {
    editable: false,
  },
): Panel {
  const dom = document.createElement('div')
  // Float the panel as a `.find-surface` card (see globals.css) so it matches the preview
  // find bar — VS Code style, overlaying the editor instead of pushing content down.
  dom.className = 'find-surface'
  const root: Root = createRoot(dom)
  let updateFn: FindPanelUpdate | null = null
  root.render(
    <EditorFindPanel
      view={view}
      editable={opts.editable}
      registerUpdate={(fn) => {
        updateFn = fn
      }}
    />,
  )
  return {
    dom,
    top: true,
    update(u: ViewUpdate) {
      updateFn?.(u.view)
    },
    destroy() {
      // Defer the unmount by a microtask. `view.destroy()` runs from the editor's React effect
      // cleanup — i.e. while the host tree is committing — and unmounting this panel's React root
      // synchronously there trips React's "Attempted to synchronously unmount a root while React
      // was already rendering" warning. A microtask lands just after the host commit finishes, so
      // the root still unmounts promptly (no leak) without racing the host render.
      queueMicrotask(() => root.unmount())
    },
  }
}
