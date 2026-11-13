import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUIStore } from '../../store/ui'
import { useDocument } from '../../hooks/useDocuments'
import { exportDocument, resolveTheme } from '../../lib/export'
import { getExportHtml } from '../../lib/exportStore'
import { prepareExportHtml } from '../../lib/exportBake'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { ExportPreview } from './ExportPreview'
import { Select } from '../ui/select'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../ui/context-menu'
import { Copy } from 'lucide-react'
import { useT } from '../../i18n'

type ThemeChoice = 'current' | 'light' | 'dark'

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_HANDLE_CLASS: Record<ResizeDir, string> = {
  n: 'top-0 left-2 right-2 h-2 cursor-ns-resize',
  s: 'bottom-0 left-2 right-2 h-2 cursor-ns-resize',
  e: 'right-0 top-2 bottom-2 w-2 cursor-ew-resize',
  w: 'left-0 top-2 bottom-2 w-2 cursor-ew-resize',
  ne: 'top-0 right-0 w-3 h-3 cursor-nesw-resize',
  nw: 'top-0 left-0 w-3 h-3 cursor-nwse-resize',
  se: 'bottom-0 right-0 w-4 h-4 cursor-nwse-resize',
  sw: 'bottom-0 left-0 w-3 h-3 cursor-nwse-resize',
}

function defaultHtmlPath(docPath: string | undefined, title: string): string {
  if (docPath) return docPath.replace(/\.(md|markdown|mdx|mdtxt|mdtext)$/i, '.html')
  return `${title.trim() || 'Untitled'}.html`
}

export function ExportDialog(): React.ReactElement {
  const open = useUIStore((s) => s.exportOpen)
  const setOpen = useUIStore((s) => s.setExportOpen)
  const uiTheme = useUIStore((s) => s.theme)
  const activeDocumentId = useUIStore((s) => s.activeDocumentId)
  // C20 add ⑦ / E12: the export cache is a non-reactive singleton, so its readiness is mirrored
  // in the store. While it is false the cache still holds the PREVIOUS document's HTML (a
  // document switch or a pending parse), so the Export button must be disabled rather than
  // writing the wrong file or showing an error the user cannot act on.
  const exportReady = useUIStore((s) => s.exportReady)
  const { t } = useT()
  const { data: doc } = useDocument(activeDocumentId)

  const [themeChoice, setThemeChoice] = useState<ThemeChoice>('current')
  const [embedImages, setEmbedImages] = useState(true)
  const [targetPath, setTargetPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Ref for the right-click edit menu on the target-path box
  const targetPathRef = useRef<HTMLInputElement>(null)
  // When the target file already exists, confirm inline within the dialog (instead of the native
  // window.confirm): the native confirm is a blocking modal that conflicts with the app menu
  // shortcut (Close Workspace = Cmd/Ctrl+W) and the current modal export dialog, which could
  // accidentally close the whole workspace at the moment of cancel/confirm.
  const [showOverwrite, setShowOverwrite] = useState(false)

  // R4: the dialog behaves like a standard window — draggable by its title bar and resizable from
  // its edges/corners. No size/position is persisted (the app stores no user preferences), so it
  // re-centers every time it opens. Until the first move/resize the dialog keeps Radix's default
  // centered layout (rect === null); the first interaction freezes its current geometry into `rect`.
  const contentRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const dragRef = useRef<
    | { kind: 'move'; px: number; py: number; x: number; y: number; w: number; h: number }
    | {
        kind: 'resize'
        dir: string
        px: number
        py: number
        x: number
        y: number
        w: number
        h: number
      }
    | null
  >(null)
  const MIN_W = 480
  // The pinned footer (options + actions) plus the fixed chrome (title bar, theme row, preview
  // caption) needs ~300px before the preview strip has anything left. Below this floor it would
  // be the FOOTER that gets pushed out of the dialog — the very bug this layout fixes at the
  // default size — so the resize path is floored above it too.
  const MIN_H = 420

  const ensureRect = (): { x: number; y: number; w: number; h: number } => {
    if (rect) return rect
    // Belt and braces: the frozen geometry must never exceed the viewport, or the subsequent
    // move/resize clamps (which bound against vw-x / vh-y) would inherit the overflow (R4).
    const vw = window.innerWidth
    const vh = window.innerHeight
    const b = contentRef.current?.getBoundingClientRect()
    const next = b
      ? {
          x: Math.max(0, Math.min(b.left, vw - MIN_W)),
          y: Math.max(0, Math.min(b.top, vh - MIN_H)),
          w: Math.min(b.width, vw),
          h: Math.min(b.height, vh),
        }
      : { x: vw / 2 - 336, y: vh / 2 - 240, w: 672, h: 480 }
    setRect(next)
    return next
  }

  const onHeaderPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const r = ensureRect()
    dragRef.current = { kind: 'move', px: e.clientX, py: e.clientY, x: r.x, y: r.y, w: r.w, h: r.h }
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onResizePointerDown = (e: React.PointerEvent, dir: string): void => {
    if (e.button !== 0) return
    const r = ensureRect()
    dragRef.current = {
      kind: 'resize',
      dir,
      px: e.clientX,
      py: e.clientY,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    }
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (d.kind === 'move') {
      const nx = Math.min(Math.max(0, d.x + (e.clientX - d.px)), vw - d.w)
      const ny = Math.min(Math.max(0, d.y + (e.clientY - d.py)), vh - d.h)
      setRect({ x: nx, y: ny, w: d.w, h: d.h })
      return
    }
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    let x = d.x
    let y = d.y
    let w = d.w
    let h = d.h
    if (d.dir.includes('e')) w = d.w + dx
    if (d.dir.includes('s')) h = d.h + dy
    if (d.dir.includes('w')) {
      w = d.w - dx
      x = d.x + dx
    }
    if (d.dir.includes('n')) {
      h = d.h - dy
      y = d.y + dy
    }
    // Clamp to the minimums, then keep the opposite edge fixed when the minimum is hit.
    w = Math.max(MIN_W, Math.min(w, vw - x))
    h = Math.max(MIN_H, Math.min(h, vh - y))
    if (d.dir.includes('w')) x = d.x + d.w - w
    if (d.dir.includes('n')) y = d.y + d.h - h
    x = Math.min(Math.max(0, x), vw - w)
    y = Math.min(Math.max(0, y), vh - h)
    setRect({ x, y, w, h })
  }
  const endDrag = (e: React.PointerEvent): void => {
    dragRef.current = null
    const el = e.currentTarget as HTMLElement
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }
  // Keyboard parity: arrow keys move (title bar) or resize (handles) the dialog.
  const onHeaderKeyDown = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 40 : 16
    const r = ensureRect()
    let nx = r.x
    let ny = r.y
    if (e.key === 'ArrowLeft') nx -= step
    else if (e.key === 'ArrowRight') nx += step
    else if (e.key === 'ArrowUp') ny -= step
    else if (e.key === 'ArrowDown') ny += step
    else return
    e.preventDefault()
    nx = Math.min(Math.max(0, nx), window.innerWidth - r.w)
    ny = Math.min(Math.max(0, ny), window.innerHeight - r.h)
    setRect({ x: nx, y: ny, w: r.w, h: r.h })
  }
  const onResizeKeyDown = (e: React.KeyboardEvent, dir: string): void => {
    const step = e.shiftKey ? 40 : 16
    // The KEY decides the direction, the handle decides which edges follow — the same split the
    // pointer path uses (dx moves the east/west edge, dy the north/south one). Deriving the sign
    // from `dir` alone made ArrowUp and ArrowDown on a south handle identical, and made a corner
    // handle grow on every arrow key.
    const hDir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    const vDir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!hDir && !vDir) return
    const r = ensureRect()
    let { x, y, w, h } = r
    // A side handle owns one axis; the key for the other axis is not ours to claim.
    const dx = dir.includes('e') || dir.includes('w') ? hDir * step : 0
    const dy = dir.includes('n') || dir.includes('s') ? vDir * step : 0
    if (!dx && !dy) return
    // ArrowRight/ArrowDown always move the edge the user is pointing at outward (grow); the
    // opposite key pulls it inward (shrink). A west/north handle therefore mirrors the sign,
    // because its edge sits on the left/top.
    w += dir.includes('e') ? dx : dir.includes('w') ? -dx : 0
    h += dir.includes('s') ? dy : dir.includes('n') ? -dy : 0
    w = Math.max(MIN_W, Math.min(w, window.innerWidth - x))
    h = Math.max(MIN_H, Math.min(h, window.innerHeight - y))
    // Keep the opposite edge fixed when the minimum is hit.
    if (dir.includes('w')) x = r.x + r.w - w
    if (dir.includes('n')) y = r.y + r.h - h
    x = Math.min(Math.max(0, x), window.innerWidth - w)
    y = Math.min(Math.max(0, y), window.innerHeight - h)
    setRect({ x, y, w, h })
    e.preventDefault()
  }

  // Re-center synchronously as the dialog opens: the OLD geometry must never be painted, or under
  // parallel-load jank a geometry assertion can catch the stale (previous-test) position and report a
  // teleport (export-dialog R4 teleport flake). This MUST run before paint, so it is a layout effect
  // and cannot share the deferred setTimeout used by the other open-state resets below.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- single, converging reset that must precede paint
    if (open) setRect(null)
  }, [open, doc])

  // Reset the remaining open-state (theme / embed / error / target) via setTimeout so the setStates are
  // not synchronous within the effect body (avoids cascading re-renders; satisfies
  // react-hooks/set-state-in-effect). `rect` is already reset above, synchronously, on open.
  useEffect(() => {
    if (open) {
      const id = setTimeout(() => {
        setThemeChoice('current')
        setEmbedImages(true)
        setError(null)
        setShowOverwrite(false)
        setTargetPath(doc ? defaultHtmlPath(doc.filePath, doc.title) : null)
      }, 0)
      return () => clearTimeout(id)
    }
  }, [open, doc])

  // C3: when the inline overwrite confirmation appears, move focus into it (WAI-ARIA dialog
  // focus management); on cancel, return focus to the primary Export button. The initial mount
  // is skipped so opening the dialog does not steal focus from Radix's default placement.
  const overwriteBtnRef = useRef<HTMLButtonElement>(null)
  const exportBtnRef = useRef<HTMLButtonElement>(null)
  const prevOverwrite = useRef(showOverwrite)
  useEffect(() => {
    if (prevOverwrite.current === showOverwrite) return
    prevOverwrite.current = showOverwrite
    if (showOverwrite) overwriteBtnRef.current?.focus()
    else exportBtnRef.current?.focus()
  }, [showOverwrite])

  const handlePickPath = async (): Promise<void> => {
    const def = doc ? defaultHtmlPath(doc.filePath, doc.title) : 'export.html'
    try {
      const p = await window.api.dialog.saveHtmlFile(def)
      if (p) setTargetPath(p)
    } catch {
      /* cancelled */
    }
  }

  // Perform the actual write. No need to pause any watcher around it: the main
  // process ignores the export artefacts it produces (.html/.pdf/.docx) when
  // watching, so writing a sibling .html cannot raise a bogus "file changed".
  const doExport = async (overwrite: boolean): Promise<void> => {
    if (!targetPath) return
    setBusy(true)
    setError(null)
    // Hard lock: mark exporting for the whole write; the store-level closeDocument/closeWorkspace
    // will ignore it, so even triggering the "Close Workspace" shortcut (Cmd/Ctrl+W) won't close
    // the current file/workspace.
    useUIStore.getState().setExporting(true)
    try {
      // ADR 0019: bake EVERY diagram into the canonical HTML before writing. The preview
      // renders diagrams lazily, so the cache still holds empty placeholders.
      await prepareExportHtml()
      await exportDocument({
        path: targetPath,
        theme: resolveTheme(themeChoice, uiTheme),
        embedImages,
        overwrite,
      })
      setOpen(false)
    } catch (e) {
      console.error('Export failed', e)
      setError(t('export.failed'))
    } finally {
      useUIStore.getState().setExporting(false)
      setBusy(false)
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!targetPath) {
      await handlePickPath()
      return
    }
    // Not ready ⇒ the cache still holds the PREVIOUS document's HTML (a switch or a pending
    // parse is in flight). An empty cache ⇒ there is nothing to export yet. Both are the same
    // user-visible situation: the document has not finished rendering.
    if (!exportReady || !getExportHtml()) {
      setError(t('export.previewNotReady'))
      return
    }
    // When the target file already exists, show the inline confirm first (don't call the native
    // window.confirm to avoid accidentally closing the workspace). If the user chose "Overwrite"
    // in the inline confirm, showOverwrite is true and we write directly with overwrite=true.
    if (!showOverwrite) {
      try {
        const st = await window.api.documents.stat(targetPath)
        if (st?.exists) {
          setShowOverwrite(true)
          return
        }
      } catch {
        // Treat as "not exists" if file status can't be read, and continue exporting.
      }
    }
    await doExport(showOverwrite)
  }

  // Path shown in the inline "file already exists" prompt. `showOverwrite` is only turned
  // on inside handleConfirm(), and that function has already returned early when
  // targetPath is null, so targetPath is non-null on any render that reaches the prompt.
  // The `?? ''` only narrows its nullable type for TypeScript.
  const overwriteTargetPath = targetPath ?? ''

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        ref={contentRef}
        className={
          // When positioned (rect !== null) the inline style below overrides the base centering
          // (left-1/2 top-1/2 -translate-1/2) because inline styles beat plain classes. Do NOT use
          // `!left-0`-style important utilities here: they would ALSO beat the inline coordinates
          // (important > inline) and pin the dialog to the top-left corner — measured 2026-11-12:
          // a bare pointerdown on any resize handle teleported the dialog to (0,0) (R4, user report).
          // When NOT positioned, size the dialog viewport-relative so it auto-fills a comfortable
          // share of the window with real margins (user report 2026-11-13, "felt too small…leave pleasing margins around it").
          // Width: min(92vw, 1120px) — on a narrow window it hugs 92% width (~4% side margin each
          // side); on a wide one it caps at 1120px so it never dwarfs the content. Height: 88vh
          // capped at 960px, leaving ~6% breathing room top and bottom and never exceeding ~66% of a
          // 1440px window. The base `left-1/2 top-1/2 -translate-x/y-1/2` centres it; the e2e geometry
          // guard pins the numbers (height must stay below 89% of the window, top/bottom ≥ 6%).
          // The base slide-up animation is cancelled by the inline style below.
          'flex flex-col ' + (rect ? '' : 'w-[min(92vw,1120px)] max-w-none h-[88vh] max-h-[960px]')
        }
        style={{
          // Cancel the base `animate-slide-up` in BOTH states. A plain `animate-none` utility does
          // NOT win: the custom animation name is unknown to tailwind-merge, so both classes
          // survive and `slideUp`'s translateY(4px) keeps the dialog below the true centre
          // (measured 2026-11-13: +3.8px at 768px). It must also stay cancelled AFTER the first
          // drag/resize freezes `rect`, otherwise the animation restarts and teleports the dialog
          // 3.4px down on a bare edge click (R4 teleport regression).
          animation: 'none',
          ...(rect
            ? {
                left: rect.x,
                top: rect.y,
                width: rect.w,
                height: rect.h,
                // Tailwind v4 compiles `-translate-x-1/2` into the CSS `translate` property, which
                // is INDEPENDENT of `transform` — clearing only `transform` still leaves the
                // base `translate: -50% -50%` active and shifts the dialog by half its own size
                // (measured: a resize-handle pointerdown moved it to (-w/2, -h/2)). Clear BOTH.
                transform: 'none',
                translate: 'none',
                maxWidth: 'none',
                maxHeight: 'none',
              }
            : {}),
        }}
      >
        <DialogHeader
          // Drag area must cover the ENTIRE top strip, including DialogContent's `p-6` padding:
          // the header used to start 24px below the border, leaving a dead 8–24px band that was
          // neither the N resize handle nor draggable (measured 2026-11-12: dx=0 for y=10/14/18/22).
          // Negative margins pull the hit area over the padding; matching padding keeps the title
          // at the same visual position, so the body below does not move.
          className="-mx-6 -mt-6 px-6 pt-6 cursor-move select-none touch-none"
          data-testid="export-dialog-header"
          tabIndex={0}
          role="toolbar"
          aria-label={t('export.dragHandle')}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onHeaderKeyDown}
        >
          <DialogTitle>{t('export.title')}</DialogTitle>
        </DialogHeader>

        {/* Theme is a CONTROL, not content: it decides what the preview shows, so it stays pinned
            above the stage instead of scrolling away with it. Inline with its label — the dialog's
            vertical budget belongs to the preview, which is the reason this dialog is tall. */}
        <div className="shrink-0 flex items-center gap-2">
          <label className="text-2xs text-[var(--color-text-tertiary)] shrink-0">
            {t('export.theme')}
          </label>
          <Select
            value={themeChoice}
            onChange={(e) => setThemeChoice(e.target.value as ThemeChoice)}
          >
            <option value="current">{t('export.themeCurrent', { theme: uiTheme })}</option>
            <option value="light">{t('export.themeLight')}</option>
            <option value="dark">{t('export.themeDark')}</option>
          </Select>
        </div>

        {/* C20 ⑨: the export preview. It renders the EXPORT's own stylesheet in a shadow root,
            so what is on screen is what the file will contain — not the app's own styling.
            W1 (the theme can be forced) is handled by the selector above; W2 (the export bakes
            every diagram, the app preview renders lazily) and W3 (the preview is always the
            single-file form, images inlined) are stated in the note below. */}
        {/* The dialog's ONLY scroll region. The old layout wrapped theme + preview + options in a
            single `overflow-auto`, so a long preview pushed the options — and with them the reason
            the user opened the dialog — out of view. The modal-anatomy fix is to pin everything
            that is NOT content: controls above, options + actions in the footer below. The preview
            host is itself a scroll container, so no nested scrollbar is created. */}
        <div className="flex flex-col flex-1 min-h-0 mt-3">
          <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">
            {t('export.previewTitle')}
          </label>
          <ExportPreview theme={resolveTheme(themeChoice, uiTheme)} />
          <p className="text-2xs text-[var(--color-text-tertiary)] mt-2">
            {t('export.previewNote')}
          </p>
        </div>

        {/* Pinned footer: every option the Export action depends on, always visible regardless of
            how long the document is. The top border encodes the split "content above / controls
            below" instead of leaving it to scroll position. */}
        <div className="shrink-0 border-t border-[var(--color-border)] mt-4 pt-4">
          {/* Inline images */}
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={embedImages}
              onChange={(e) => setEmbedImages(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            {t('export.inlineImages')}
          </label>

          {/* Target path */}
          <div className="mt-3">
            <label className="block text-2xs text-[var(--color-text-tertiary)] mb-1">
              {t('export.saveLocation')}
            </label>
            <div className="flex items-center gap-2">
              {/* Right-click menu: one-click "Copy full path" ( / #4b). A read-only export target can't be edited, so the generic edit menu (undo / cut / paste) would only offer copy / select-all but copy alone copies the selection, not the full path. This dedicated item copies the whole target path regardless of selection */}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <Input
                    ref={targetPathRef}
                    value={targetPath ?? ''}
                    readOnly
                    placeholder={t('export.notSelected')}
                    className="w-auto flex-1 h-auto text-xs px-2 py-1.5 bg-[var(--color-bg)] text-[var(--color-text-secondary)] truncate"
                  />
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    data-testid="exp-copy-full-path"
                    onClick={() => void window.api.clipboard.writeText(targetPath ?? '')}
                  >
                    <Copy size={13} /> {t('editor.copyFullPath')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <Button variant="outline" size="sm" onClick={handlePickPath}>
                {t('export.choose')}
              </Button>
            </div>
            <p className="text-2xs text-[var(--color-text-tertiary)] mt-1">
              {t('export.imageNote')}
            </p>
          </div>

          {error && (
            <p className="text-2xs text-[var(--color-text-primary)] mt-2">
              <span className="text-[var(--color-danger)]">⚠</span> {error}
            </p>
          )}
        </div>

        {showOverwrite ? (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 mt-3 shrink-0">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t('export.overwritePrompt', { path: overwriteTargetPath })}
            </p>
            <div className="flex items-center justify-end gap-3 mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowOverwrite(false)}
                disabled={busy}
              >
                {t('export.cancel')}
              </Button>
              <Button
                variant="accent"
                size="sm"
                onClick={() => doExport(true)}
                disabled={busy}
                ref={overwriteBtnRef}
              >
                {busy ? (
                  <>
                    <Spinner />
                    {t('export.exporting')}
                  </>
                ) : (
                  t('export.overwrite')
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-3 mt-3 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('export.cancel')}
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={handleConfirm}
              disabled={busy || !exportReady}
              ref={exportBtnRef}
            >
              {busy ? (
                <>
                  <Spinner />
                  {t('export.exporting')}
                </>
              ) : exportReady ? (
                t('export.export')
              ) : (
                t('export.preparing')
              )}
            </Button>
          </div>
        )}

        {/* R4: standard window operations — 8 resize handles on the dialog edges/corners. A visible,
            focusable separator is used instead of CSS `resize: both`, which cannot be located or
            driven by automation and has no accessible role. */}
        {RESIZE_DIRS.map((dir) => (
          <div
            key={dir}
            data-testid={`export-dialog-resize-${dir}`}
            role="separator"
            aria-label={t('export.resizeHandle')}
            aria-orientation={
              dir.length === 1
                ? dir === 'e' || dir === 'w'
                  ? 'horizontal'
                  : 'vertical'
                : undefined
            }
            tabIndex={0}
            onPointerDown={(e) => onResizePointerDown(e, dir)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={(e) => onResizeKeyDown(e, dir)}
            className={`absolute touch-none focus-ring ${RESIZE_HANDLE_CLASS[dir]}`}
          />
        ))}
      </DialogContent>
    </Dialog>
  )
}
