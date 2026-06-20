import React, { useEffect, useRef } from 'react'
import { useUIStore } from './store/ui'
import { useImportDocuments } from './hooks/useDocuments'
import { Sidebar } from './components/sidebar/Sidebar'
import { EditorPane } from './components/editor/EditorPane'
import { CommandPalette } from './components/editor/CommandPalette'
import { NewDocumentDialog } from './components/editor/NewDocumentDialog'
import { TooltipProvider } from './components/ui/tooltip'

export default function App(): React.ReactElement {
  const { setNewDocOpen, toggleSidebar, setActiveDocumentId, theme } = useUIStore()
  const importMut = useImportDocuments()
  const hasAutoFitted = useRef(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.includes('Mac')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key === 'n') { e.preventDefault(); setNewDocOpen(true) }
      if (mod && e.key === '\\') { e.preventDefault(); toggleSidebar() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [setNewDocOpen, toggleSidebar])

  useEffect(() => {
    if (!window.api) return
    const removeNew = window.api.onMenuEvent('new-document', () => setNewDocOpen(true))
    const removeSidebar = window.api.onMenuEvent('toggle-sidebar', () => toggleSidebar())
    const removeFit = window.api.onMenuEvent('fit-to-content', () => {
      fitWindowToContent()
    })
    const removeOpen = window.api.onMenuEvent('open-files', (data) => {
      const filePaths = Array.isArray(data) ? data : (data ? [data as string] : [])
      if (filePaths.length === 0) return
      importMut.mutate(filePaths, {
        onSuccess: (imported) => {
          if (imported.length > 0) {
            setActiveDocumentId(imported[0].id)
          }
        }
      })
    })
    return () => { removeNew(); removeSidebar(); removeOpen(); removeFit() }
  }, [setNewDocOpen, toggleSidebar, setActiveDocumentId, importMut])

  // Auto-fit window to content once, on first document load.
  // After that, user can trigger via View menu → Fit Window to Content.
  const { activeDocumentId } = useUIStore()
  useEffect(() => {
    if (!activeDocumentId || hasAutoFitted.current) return
    hasAutoFitted.current = true
    // Wait for DOM to settle (preview needs to render first)
    const timer = setTimeout(() => fitWindowToContent(), 800)
    return () => clearTimeout(timer)
  }, [activeDocumentId])

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen overflow-hidden bg-[var(--color-bg)]">
        <Sidebar />
        <EditorPane />
        <CommandPalette />
        <NewDocumentDialog />
      </div>
    </TooltipProvider>
  )
}

/**
 * Measure the rendered document content and ask the main process to
 * resize the window so the content fits (clamped to screen work area).
 */
function fitWindowToContent(): void {
  if (!window.api?.window?.fitToContent) return
  // Find the preview/editor content element — use scrollWidth/scrollHeight
  // of the scrollable container to capture full content size.
  const previewEl = document.querySelector('.markdown-preview') as HTMLElement | null
  const editorEl = document.querySelector('.editor-content') as HTMLElement | null

  // Prefer preview (it's the rendered form); fall back to editor.
  const contentEl = previewEl || editorEl
  if (!contentEl) return

  // scrollWidth/Height give the full content size including overflow.
  // But for "fit width", we want the natural content width without scrollbar.
  // Use the widest child's offsetWidth as a proxy.
  const containerEl = contentEl.parentElement  // the overflow-auto div
  let contentWidth = contentEl.scrollWidth
  let contentHeight = contentEl.scrollHeight

  // For width, try to measure the widest block element (more accurate than scrollWidth
  // which includes scrollbar gutter).
  const blocks = contentEl.querySelectorAll('h1,h2,h3,p,pre,table,ul,ol,blockquote,img,.katex-display')
  for (const b of Array.from(blocks)) {
    const w = (b as HTMLElement).offsetWidth
    if (w > contentWidth) contentWidth = w
  }

  // Cap content height to screen height — we don't want a 10000px window
  // for a 500-line document. Use ~80% of viewport as a sensible max.
  const maxH = Math.floor(window.screen.availHeight * 0.9)
  contentHeight = Math.min(contentHeight, maxH)

  window.api.window.fitToContent(contentWidth, contentHeight)
}
