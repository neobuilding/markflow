import React, { useState, useEffect, useRef } from 'react'
import {
  Hash,
  Bold,
  Italic,
  Code,
  Link,
  List,
  CheckSquare,
  Search,
  Replace,
  Undo2,
  Redo2,
  Lock,
  PenLine,
  MoreHorizontal,
} from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu'
import { useT, type TranslationKey } from '../../i18n'
import { useUIStore } from '../../store/ui'
import { useEditorHistory } from '../../store/editorHistory'
import { formatShortcut } from '../../lib/utils'
import { FORMAT_SHORTCUTS, type FormatActionId } from '../../lib/format-shortcuts'

// The editor pane bar (ADR-0024 §10 trade-off 52 / ADR-0025 P2.1): the editor-only clusters that
// used to sit on the global header sink here so each column carries its own bar in split mode. It
// reuses the same document-level event channels the global bar used (markdown:insert / markdown:find
// / markdown:replace / markdown:undo / markdown:redo) — no new plumbing.
interface FormatButton {
  icon: React.ComponentType<{ size?: number }>
  /**
   * The action's id in the shared format-shortcut table. That table owns the BINDING, the inserted
   * markup and the advertised glyph, so a tooltip can never promise a key the handler does not
   * implement (ADR-0032).
   */
  id: FormatActionId
  /** Tooltip key. Carries the keyboard shortcut. */
  tip: TranslationKey
  /** Accessible-name key. Defaults to `tip` when omitted (the name states the action alone). */
  label?: TranslationKey
}

const FORMAT_BUTTONS: FormatButton[] = [
  { icon: Hash, id: 'heading1', tip: 'editor.fmt.h1Shortcut', label: 'editor.fmt.h1' },
  { icon: Bold, id: 'bold', tip: 'editor.fmt.boldShortcut', label: 'editor.fmt.bold' },
  { icon: Italic, id: 'italic', tip: 'editor.fmt.italicShortcut', label: 'editor.fmt.italic' },
  { icon: Code, id: 'code', tip: 'editor.fmt.codeShortcut', label: 'editor.fmt.code' },
  { icon: Link, id: 'link', tip: 'editor.fmt.linkShortcut', label: 'editor.fmt.link' },
  { icon: List, id: 'list', tip: 'editor.fmt.listShortcut', label: 'editor.fmt.list' },
  { icon: CheckSquare, id: 'task', tip: 'editor.fmt.taskShortcut', label: 'editor.fmt.task' },
]

function insertMarkdown(before: string, after = '') {
  document.dispatchEvent(new CustomEvent('markdown:insert', { detail: { before, after } }))
}

// Collapse threshold, in pixels of COLUMN width (ADR-0024 §10 trade-off 54 — the split ratio is
// user-draggable down to 0.2, so a viewport breakpoint can never see the pane width). The full
// budget (7 format + find / replace / undo / redo / read-only ≈ 12 items) stops fitting the
// 32–36px hit areas at ~420px, below which EVERYTHING folds into a single VS Code-style "…"
// overflow where each command carries a visible label (ADR-0024 §10 trade-off 54). One threshold, one
// overflow button — there is no separate, undiscoverable "Format" dropdown anymore.
const FOLD_AT = 420

type BarMode = 'wide' | 'narrow'

export function EditorPaneBar({ editable }: { editable: boolean }): React.ReactElement {
  const { t } = useT()
  const toggleEditable = useUIStore((s) => s.toggleEditable)
  const canUndo = useEditorHistory((s) => s.canUndo)
  const canRedo = useEditorHistory((s) => s.canRedo)
  const barRef = useRef<HTMLDivElement>(null)
  // The width is the bar's BORDER box, which equals the COLUMN width it fills (ADR-0024 §10). We read
  // `borderBoxSize` rather than `contentRect`: the latter is the content box and would subtract the
  // bar's own horizontal padding (`px-3`), silently shifting every threshold by that padding and
  // disagreeing with the column-width arithmetic the e2e environments are derived from
  // (e2e/helpers/viewports.ts, e2e/guards/viewports.test.ts). `el.getBoundingClientRect().width`
  // is the fallback for engines without `borderBoxSize`.
  const [mode, setMode] = useState<BarMode>('wide')

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const borderBox = entries[0]?.borderBoxSize as unknown as
        ReadonlyArray<{ inlineSize: number }> | undefined
      const w = borderBox?.[0]?.inlineSize ?? el.getBoundingClientRect().width
      setMode(w < FOLD_AT ? 'narrow' : 'wide')
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The three editor-only actions, rendered either inline (wide) or inside the "…" overflow (narrow).
  // One definition, two placements — so the overflow can never drift from the inline bar.
  const editorActions: Array<{
    key: string
    icon: React.ComponentType<{ size?: number }>
    label: string
    hint?: string
    disabled: boolean
    onClick: () => void
    testId: string
  }> = [
    {
      key: 'undo',
      icon: Undo2,
      label: t('ctx.undo'),
      disabled: !editable || !canUndo,
      onClick: () => document.dispatchEvent(new CustomEvent('markdown:undo')),
      testId: 'editor-undo-btn',
    },
    {
      key: 'redo',
      icon: Redo2,
      label: t('ctx.redo'),
      disabled: !editable || !canRedo,
      onClick: () => document.dispatchEvent(new CustomEvent('markdown:redo')),
      testId: 'editor-redo-btn',
    },
    {
      key: 'readonly',
      icon: editable ? PenLine : Lock,
      // The icon-only toggle's accessible name states the CURRENT mode; the tooltip states the
      // ACTION, so neither leaves the reader guessing (WCAG 2.4.6 / 4.1.2). Edit is the active /
      // pressed state (aria-pressed = editable) and read-only the resting one — so the default
      // (read-only) shows a DIM lock, not a highlighted one (fixes the "always highlighted" complaint
      // and the inverted-label bug where an editable doc was labeled read-only).
      label: editable ? t('editor.edit') : t('editor.readOnly'),
      hint: editable ? t('editor.switchReadOnly') : t('editor.switchEdit'),
      disabled: false,
      onClick: () => toggleEditable(),
      testId: 'editor-readonly-btn',
    },
  ]

  // The tooltip / overflow text of a format action. The glyph comes from the shared
  // format-shortcut table and is rendered through `formatShortcut`, so the label reads `Ctrl+B` off
  // macOS — the app's own key handler resolves Ctrl there, and a hard-coded '⌘B' would advertise a
  // Command key to users who have none.
  const tipText = ({ tip, id }: FormatButton): string =>
    t(tip, { shortcut: formatShortcut(FORMAT_SHORTCUTS[id].glyph) })

  const formatButtons = FORMAT_BUTTONS.map((btn) => {
    const { icon: Icon, id, tip, label } = btn
    const { before, after } = FORMAT_SHORTCUTS[id]
    return (
      <Tooltip key={tip}>
        <TooltipTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            data-testid={`fmt-${before}-${after}`}
            aria-label={t(label ?? tip)}
            disabled={!editable}
            onClick={() => insertMarkdown(before, after)}
          >
            <Icon size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tipText(btn)}</TooltipContent>
      </Tooltip>
    )
  })

  const BAR_CLASS =
    'titlebar-no-drag flex items-center gap-1 px-3 h-9 border-b border-[var(--color-border)] bg-[var(--color-bg)] shrink-0'

  if (mode === 'wide') {
    return (
      <div ref={barRef} data-testid="editor-pane-bar" className={BAR_CLASS}>
        <div className="flex items-center gap-1 mr-1.5 pr-1.5 border-r border-[var(--color-border)]">
          {formatButtons}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="toolbar"
              size="icon"
              data-testid="editor-find-btn"
              aria-label={t('editor.findShortcut', { shortcut: formatShortcut('⌘F') })}
              onClick={() => document.dispatchEvent(new CustomEvent('markdown:find'))}
            >
              <Search size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('editor.findShortcut', { shortcut: formatShortcut('⌘F') })}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="toolbar"
              size="icon"
              data-testid="editor-replace-btn"
              aria-label={t('editor.replaceShortcut', { shortcut: formatShortcut('⌘H') })}
              onClick={() => document.dispatchEvent(new CustomEvent('markdown:replace'))}
            >
              <Replace size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('editor.replaceShortcut', { shortcut: formatShortcut('⌘H') })}
          </TooltipContent>
        </Tooltip>

        <div className="w-px h-4 bg-[var(--color-border)] mx-1" />

        {editorActions.map(({ key, icon: Icon, label, hint, disabled, onClick, testId }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <Button
                variant="toolbar"
                size="icon"
                data-testid={testId}
                aria-label={label}
                aria-pressed={key === 'readonly' ? editable : undefined}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hint ?? label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    )
  }

  // narrow: a single VS Code-style "…" overflow holding EVERY command with a visible label, so
  // nothing is hidden behind an unlabeled glyph (the old "Type" format dropdown was undiscoverable).
  return (
    <div ref={barRef} data-testid="editor-pane-bar" className={BAR_CLASS}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            data-testid="editor-overflow-btn"
            aria-label={t('editor.more')}
          >
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {FORMAT_BUTTONS.map((btn) => {
            const { icon: Icon, id, tip } = btn
            const { before, after } = FORMAT_SHORTCUTS[id]
            return (
              <DropdownMenuItem
                key={tip}
                data-testid={`fmt-${before}-${after}`}
                disabled={!editable}
                onClick={() => insertMarkdown(before, after)}
              >
                <Icon size={13} />
                {tipText(btn)}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="editor-find-btn"
            onClick={() => document.dispatchEvent(new CustomEvent('markdown:find'))}
          >
            <Search size={13} />
            {t('editor.findShortcut', { shortcut: formatShortcut('⌘F') })}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="editor-replace-btn"
            onClick={() => document.dispatchEvent(new CustomEvent('markdown:replace'))}
          >
            <Replace size={13} />
            {t('editor.replaceShortcut', { shortcut: formatShortcut('⌘H') })}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {editorActions.map(({ key, icon: Icon, label, hint, disabled, onClick, testId }) => (
            <DropdownMenuItem key={key} data-testid={testId} disabled={disabled} onClick={onClick}>
              <Icon size={13} />
              {hint ?? label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
