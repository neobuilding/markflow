import React, { useRef } from 'react'
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
import { EDITOR_BAR_CHROME, useOverflowFocus, usePriorityOverflow } from '../ui/priority-overflow'

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

// Progressive "priority+" overflow (VS Code / Fluent / Radix-style navigation menus): the bar
// keeps its highest-priority commands inline and moves the rest into ONE "…" menu ONE AT A TIME as
// the COLUMN narrows (the split ratio is user-draggable down to 0.2, so a viewport breakpoint can
// never see the pane width). Width budgets and the ResizeObserver live in ui/priority-overflow.ts,
// which also owns ALL_INLINE_AT — the source the e2e viewport guard derives its contract from.
// There is still no separate, undiscoverable "Format" dropdown.
type CommandGroup = 'format' | 'find' | 'editing'

interface BarCommand {
  key: string
  group: CommandGroup
  icon: React.ComponentType<{ size?: number }>
  /** Accessible name of the inline icon button. */
  label: string
  /** Visible label of the overflow entry (and the tooltip, unless `tip` overrides it). */
  menuLabel: string
  tip?: string
  disabled: boolean
  onClick: () => void
  testId: string
  /** Only the read-only toggle is a toggle button; `undefined` omits aria-pressed entirely. */
  pressed?: boolean
}

export function EditorPaneBar({ editable }: { editable: boolean }): React.ReactElement {
  const { t } = useT()
  const toggleEditable = useUIStore((s) => s.toggleEditable)
  const canUndo = useEditorHistory((s) => s.canUndo)
  const canRedo = useEditorHistory((s) => s.canRedo)
  const barRef = useRef<HTMLDivElement>(null)

  // The tooltip / overflow text of a format action. The glyph comes from the shared
  // format-shortcut table and is rendered through `formatShortcut`, so the label reads `Ctrl+B` off
  // macOS — the app's own key handler resolves Ctrl there, and a hard-coded '⌘B' would advertise a
  // Command key to users who have none.
  const tipText = ({ tip, id }: FormatButton): string =>
    t(tip, { shortcut: formatShortcut(FORMAT_SHORTCUTS[id].glyph) })
  const findLabel = t('editor.findShortcut', { shortcut: formatShortcut('⌘F') })
  const replaceLabel = t('editor.replaceShortcut', { shortcut: formatShortcut('⌘H') })

  // ONE ordered command list drives BOTH placements, so the overflow can never drift from the
  // inline bar. Order is DESCENDING priority: the leftmost formatting cluster survives the longest
  // and the rightmost commands are the first to move into "…".
  const commands: BarCommand[] = [
    ...FORMAT_BUTTONS.map((btn): BarCommand => {
      const { icon, id, tip, label } = btn
      const { before, after } = FORMAT_SHORTCUTS[id]
      return {
        key: tip,
        group: 'format',
        icon,
        label: t(label ?? tip),
        menuLabel: tipText(btn),
        tip: tipText(btn),
        disabled: !editable,
        onClick: () => insertMarkdown(before, after),
        testId: `fmt-${before}-${after}`,
      }
    }),
    {
      key: 'find',
      group: 'find',
      icon: Search,
      label: findLabel,
      menuLabel: findLabel,
      disabled: false,
      onClick: () => document.dispatchEvent(new CustomEvent('markdown:find')),
      testId: 'editor-find-btn',
    },
    {
      key: 'replace',
      group: 'find',
      icon: Replace,
      label: replaceLabel,
      menuLabel: replaceLabel,
      disabled: false,
      onClick: () => document.dispatchEvent(new CustomEvent('markdown:replace')),
      testId: 'editor-replace-btn',
    },
    {
      key: 'undo',
      group: 'editing',
      icon: Undo2,
      label: t('ctx.undo'),
      menuLabel: t('ctx.undo'),
      disabled: !editable || !canUndo,
      onClick: () => document.dispatchEvent(new CustomEvent('markdown:undo')),
      testId: 'editor-undo-btn',
    },
    {
      key: 'redo',
      group: 'editing',
      icon: Redo2,
      label: t('ctx.redo'),
      menuLabel: t('ctx.redo'),
      disabled: !editable || !canRedo,
      onClick: () => document.dispatchEvent(new CustomEvent('markdown:redo')),
      testId: 'editor-redo-btn',
    },
    {
      key: 'readonly',
      group: 'editing',
      icon: editable ? PenLine : Lock,
      // The icon-only toggle's accessible name states the CURRENT mode; the tooltip and the
      // overflow entry state the ACTION (WCAG 2.4.6 / 4.1.2). Edit is the active / pressed state.
      label: editable ? t('editor.edit') : t('editor.readOnly'),
      menuLabel: editable ? t('editor.switchReadOnly') : t('editor.switchEdit'),
      disabled: false,
      onClick: () => toggleEditable(),
      testId: 'editor-readonly-btn',
      pressed: editable,
    },
  ]

  // This bar owns the format-group border + find/replace divider, hence the full 40px chrome.
  const visible = usePriorityOverflow(barRef, commands.length, EDITOR_BAR_CHROME)
  const inline = commands.slice(0, visible)
  const overflow = commands.slice(visible)
  useOverflowFocus(barRef, visible, commands.length)

  const renderInline = (cmd: BarCommand) => {
    const Icon = cmd.icon
    return (
      <Tooltip key={cmd.key}>
        <TooltipTrigger asChild>
          <Button
            variant="toolbar"
            size="icon"
            data-testid={cmd.testId}
            data-command-index={commands.findIndex((c) => c.key === cmd.key)}
            aria-label={cmd.label}
            aria-pressed={cmd.pressed}
            disabled={cmd.disabled}
            onClick={cmd.onClick}
          >
            <Icon size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{cmd.tip ?? cmd.menuLabel}</TooltipContent>
      </Tooltip>
    )
  }

  const renderOverflowItem = (cmd: BarCommand, separator: boolean) => {
    const Icon = cmd.icon
    return (
      <React.Fragment key={cmd.key}>
        {separator && <DropdownMenuSeparator />}
        <DropdownMenuItem data-testid={cmd.testId} disabled={cmd.disabled} onClick={cmd.onClick}>
          <Icon size={13} />
          {cmd.menuLabel}
        </DropdownMenuItem>
      </React.Fragment>
    )
  }

  const formatInline = inline.filter((c) => c.group === 'format')
  const findInline = inline.filter((c) => c.group === 'find')
  const editingInline = inline.filter((c) => c.group === 'editing')

  const BAR_CLASS =
    'titlebar-no-drag flex items-center gap-1 px-3 h-9 border-b border-[var(--color-border)] bg-[var(--color-bg)] shrink-0'

  return (
    <div ref={barRef} data-testid="editor-pane-bar" className={BAR_CLASS}>
      {formatInline.length > 0 && (
        <div
          className={`flex items-center gap-1 mr-1.5 pr-1.5${
            findInline.length > 0 || editingInline.length > 0
              ? ' border-r border-[var(--color-border)]'
              : ''
          }`}
        >
          {formatInline.map(renderInline)}
        </div>
      )}
      {findInline.map(renderInline)}
      {findInline.length > 0 && editingInline.length > 0 && (
        <div className="w-px h-4 bg-[var(--color-border)] mx-1" />
      )}
      {editingInline.map(renderInline)}
      {overflow.length > 0 && (
        <DropdownMenu>
          {/* docs/agents/ui-control-reuse.md:17 — every icon button pairs a Tooltip with its
              aria-label; the preview pane bar's conditional "…" trigger does the same. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="toolbar"
                  size="icon"
                  data-testid="editor-overflow-btn"
                  data-overflow-trigger
                  aria-label={t('editor.more')}
                >
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('editor.more')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {overflow.map((cmd, i) =>
              renderOverflowItem(cmd, i > 0 && overflow[i - 1].group !== cmd.group),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
