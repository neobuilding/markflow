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
  Type,
  MoreHorizontal,
} from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu'
import { useT } from '../../i18n'
import { useUIStore } from '../../store/ui'
import { useEditorHistory } from '../../store/editorHistory'
import { formatShortcut } from '../../lib/utils'

// The editor pane bar (ADR-0024 §10 trade-off 52 / ADR-0025 P2.1): the editor-only clusters that
// used to sit on the global header sink here so each column carries its own bar in split mode. It
// reuses the same document-level event channels the global bar used (markdown:insert / markdown:find
// / markdown:replace / markdown:undo / markdown:redo) — no new plumbing.
const FORMAT_BUTTONS = [
  { icon: Hash, before: '# ', after: '', tip: 'editor.fmt.h1' },
  { icon: Bold, before: '**', after: '**', tip: 'editor.fmt.bold' },
  { icon: Italic, before: '_', after: '_', tip: 'editor.fmt.italic' },
  { icon: Code, before: '`', after: '`', tip: 'editor.fmt.code' },
  { icon: Link, before: '[', after: '](url)', tip: 'editor.fmt.link' },
  { icon: List, before: '- ', after: '', tip: 'editor.fmt.list' },
  { icon: CheckSquare, before: '- [ ] ', after: '', tip: 'editor.fmt.task' },
] as const

function insertMarkdown(before: string, after = '') {
  document.dispatchEvent(new CustomEvent('markdown:insert', { detail: { before, after } }))
}

// Collapse thresholds, in pixels of COLUMN width (ADR-0024 §10 trade-off 54 — the split ratio is
// user-draggable down to 0.2, so a viewport breakpoint can never see the pane width). They are the
// widths at which the respective item sets stop fitting at the 32–36px hit areas this design uses
// (§2): 6 items ≈ 218px, 4 items ≈ 150px.
const FOLD_AT = 420
const MINIMAL_AT = 240

type BarMode = 'wide' | 'folded' | 'minimal'

export function EditorPaneBar({ editable }: { editable: boolean }): React.ReactElement {
  const { t } = useT()
  const toggleEditable = useUIStore((s) => s.toggleEditable)
  const canUndo = useEditorHistory((s) => s.canUndo)
  const canRedo = useEditorHistory((s) => s.canRedo)
  const barRef = useRef<HTMLDivElement>(null)
  // Collapse stages, driven by the COLUMN width (ADR-0024 §10 trade-off 54):
  //
  //   wide    — the full 12-item budget (7 format + find / replace / undo / redo / read-only).
  //   folded  — the format cluster becomes one `Format` dropdown (7 → 1), leaving 6 items.
  //   minimal — even 6 items do not fit a very narrow column, so undo / redo / read-only move into
  //             a VS Code-style `…` overflow (3 → 1), leaving 4.
  const [mode, setMode] = useState<BarMode>('wide')

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setMode(w < MINIMAL_AT ? 'minimal' : w < FOLD_AT ? 'folded' : 'wide')
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The three editor-only actions, rendered either inline or inside the `…` overflow. One
  // definition, two placements — so the overflow can never drift from the inline bar.
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
      icon: editable ? Lock : PenLine,
      // The icon-only toggle's accessible name states the CURRENT mode; the tooltip states the
      // ACTION, so neither leaves the reader guessing (WCAG 2.4.6 / 4.1.2).
      label: editable ? t('editor.readOnly') : t('editor.edit'),
      hint: editable ? t('editor.switchReadOnly') : t('editor.switchEdit'),
      disabled: false,
      onClick: () => toggleEditable(),
      testId: 'editor-readonly-btn',
    },
  ]

  const formatButtons = FORMAT_BUTTONS.map(({ icon: Icon, before, after, tip }) => (
    <Tooltip key={tip}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid={`fmt-${before}-${after}`}
          aria-label={t(tip)}
          disabled={!editable}
          onClick={() => insertMarkdown(before, after)}
        >
          <Icon size={16} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t(tip)}</TooltipContent>
    </Tooltip>
  ))

  return (
    <div
      ref={barRef}
      data-testid="editor-pane-bar"
      className="titlebar-no-drag flex items-center gap-0.5 px-3 h-9 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0"
    >
      {mode === 'wide' ? (
        <div className="flex items-center gap-0.5 mr-1.5 pr-1.5 border-r border-[var(--color-border)]">
          {formatButtons}
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="fmt-dropdown-btn"
              aria-label={t('editor.format')}
            >
              <Type size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {FORMAT_BUTTONS.map(({ icon: Icon, before, after, tip }) => (
              <DropdownMenuItem
                key={tip}
                data-testid={`fmt-${before}-${after}`}
                disabled={!editable}
                onClick={() => insertMarkdown(before, after)}
              >
                <Icon size={13} />
                {t(tip)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
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
            variant="ghost"
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

      {mode === 'minimal' ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="editor-overflow-btn"
              aria-label={t('editor.more')}
            >
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editorActions.map(({ key, icon: Icon, label, hint, disabled, onClick, testId }) => (
              <DropdownMenuItem
                key={key}
                data-testid={testId}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon size={13} />
                {hint ?? label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        editorActions.map(({ key, icon: Icon, label, hint, disabled, onClick, testId }) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-testid={testId}
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hint ?? label}</TooltipContent>
          </Tooltip>
        ))
      )}
    </div>
  )
}
