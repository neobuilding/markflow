import React, { useState } from 'react'
import { useT } from '../../i18n'
import { formatShortcut } from '../../lib/utils'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from './context-menu'
import { Undo2, Redo2, Scissors, Copy, ClipboardPaste, List } from 'lucide-react'

// Right-click edit menu for <input> elements (PLAN §11 / 需求 §5.14).
//
// The framework ships no built-in edit menu, and `document.execCommand` — although
// deprecated — is the ONLY way to keep the browser's native undo stack intact, so undo /
// redo route through it. Copy uses the app's own clipboard channel (more reliable than
// navigator.clipboard when the window focus is restricted), and paste inserts through
// `insertText` so React's controlled `onChange` still fires.
export interface InputContextMenuProps {
  /** Ref to the <input> the menu operates on. */
  targetRef: React.RefObject<HTMLInputElement | null>
  /** A read-only input (e.g. the export target path) cannot cut / paste / undo / redo. */
  readOnly?: boolean
  children: React.ReactNode
}

// The selection offsets are typed `number | null` but are always numeric for a text input,
// so they are asserted non-null — that keeps the snapshot branch-free.
function selectedText(el: HTMLInputElement): string {
  return el.value.slice(el.selectionStart!, el.selectionEnd!)
}

interface MenuState {
  hasValue: boolean
  hasSelection: boolean
  /** The live <input> element, captured when the menu opens (see `refresh`). */
  el: HTMLInputElement | null
}

export function InputContextMenu({
  targetRef,
  readOnly = false,
  children,
}: InputContextMenuProps): React.ReactElement {
  const { t } = useT()
  const [state, setState] = useState<MenuState>({ hasValue: false, hasSelection: false, el: null })

  // Snapshot the input state (and grab its element) at the moment the menu opens. This is
  // the same "snapshot on open" discipline the editor menu uses. Reading `targetRef.current`
  // here is fine — `onOpenChange` fires on a Radix event, never during render — which keeps
  // us clear of the react-hooks/refs rule.
  const refresh = (open: boolean) => {
    if (!open) {
      setState((s) => ({ ...s, el: null }))
      return
    }
    const el = targetRef.current
    /* v8 ignore next -- defensive: the input is always mounted while its context menu is open */
    if (!el) return
    setState({
      hasValue: el.value.length > 0,
      hasSelection: el.selectionStart! !== el.selectionEnd!,
      el,
    })
  }

  const run = (fn: (el: HTMLInputElement) => void) => () => {
    const el = state.el
    /* v8 ignore next -- defensive: el is captured on open; unreachable when the menu is open */
    if (!el) return
    fn(el)
  }

  const undo = run((el) => {
    el.focus()
    document.execCommand('undo')
  })
  const redo = run((el) => {
    el.focus()
    document.execCommand('redo')
  })
  const cut = run((el) => {
    void window.api.clipboard.writeText(selectedText(el))
    el.focus()
    document.execCommand('insertText', false, '')
  })
  const copy = run((el) => {
    void window.api.clipboard.writeText(selectedText(el))
  })
  const paste = run((el) => {
    el.focus()
    void navigator.clipboard.readText().then((text) => {
      document.execCommand('insertText', false, text)
    })
  })
  const selectAll = run((el) => {
    el.focus()
    el.select()
  })

  return (
    <ContextMenu onOpenChange={refresh}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-testid="ctx-undo"
          shortcut={formatShortcut('⌘Z')}
          disabled={readOnly}
          onClick={undo}
        >
          <Undo2 size={13} /> {t('ctx.undo')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="ctx-redo"
          shortcut={formatShortcut('⌘⇧Z')}
          disabled={readOnly}
          onClick={redo}
        >
          <Redo2 size={13} /> {t('ctx.redo')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="ctx-cut"
          shortcut={formatShortcut('⌘X')}
          disabled={readOnly || !state.hasSelection}
          onClick={cut}
        >
          <Scissors size={13} /> {t('ctx.cut')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="ctx-copy"
          shortcut={formatShortcut('⌘C')}
          disabled={!state.hasSelection}
          onClick={copy}
        >
          <Copy size={13} /> {t('ctx.copy')}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="ctx-paste"
          shortcut={formatShortcut('⌘V')}
          disabled={readOnly}
          onClick={paste}
        >
          <ClipboardPaste size={13} /> {t('ctx.paste')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="ctx-select-all"
          shortcut={formatShortcut('⌘A')}
          disabled={!state.hasValue}
          onClick={selectAll}
        >
          <List size={13} /> {t('ctx.selectAll')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
