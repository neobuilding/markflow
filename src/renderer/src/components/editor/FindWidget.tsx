import React, { type Ref } from 'react'
import { Search, X, Replace } from 'lucide-react'
import { SearchInput } from '../ui/search-input'
import { IconToggleGroup, type ToggleItem } from '../ui/icon-toggle-group'
import { MatchCounter } from '../ui/match-counter'
import { useT } from '../../i18n'
// The toggle types live in lib/find-toggles.ts so the editor panel and the preview bar share one
// definition (and one key->field mapping) instead of declaring their own.
import type { FindToggleKey, FindToggleState } from '../../lib/find-toggles'

export interface FindWidgetProps {
  testId: string
  query: string
  onQueryChange: (q: string) => void
  total: number
  current: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  toggleState: FindToggleState
  onToggle: (key: FindToggleKey) => void
  showReplace?: boolean
  replaceText?: string
  onReplaceTextChange?: (s: string) => void
  onReplaceNext?: () => void
  onReplaceAll?: () => void
  inputRef?: Ref<HTMLInputElement>
  // Tag the query input with `main-field` so CodeMirror focuses it on panel open.
  mainField?: boolean
  placeholder?: string
}

// Shared find-widget UI shell used by BOTH the editor panel and the preview bar so
// every find surface speaks one visual language: input + Aa/ab/.* toggles (+AB when
// replace is shown) + k/n counter with steppers + (optional) replace row + close.
// Navigation shortcuts (Enter / Shift+Enter / F3 / Shift+F3 / Ctrl|Cmd+G / Esc) are
// handled here so both surfaces behave identically.
export function FindWidget({
  testId,
  query,
  onQueryChange,
  total,
  current,
  onPrev,
  onNext,
  onClose,
  toggleState,
  onToggle,
  showReplace = false,
  replaceText = '',
  onReplaceTextChange,
  onReplaceNext,
  onReplaceAll,
  inputRef,
  mainField = false,
  placeholder,
}: FindWidgetProps): React.ReactElement {
  const { t } = useT()

  const items: ToggleItem[] = [
    {
      key: 'case',
      label: t('find.toggle.caseShort'),
      active: toggleState.caseSensitive,
      title: t('find.toggle.case'),
      ariaLabel: t('find.toggle.case'),
    },
    {
      key: 'word',
      label: t('find.toggle.wholeWordShort'),
      active: toggleState.wholeWord,
      title: t('find.toggle.wholeWord'),
      ariaLabel: t('find.toggle.wholeWord'),
    },
    {
      key: 'regex',
      label: t('find.toggle.regexShort'),
      active: toggleState.regexp,
      title: t('find.toggle.regex'),
      ariaLabel: t('find.toggle.regex'),
    },
  ]
  if (showReplace) {
    items.push({
      key: 'preserve',
      label: t('find.toggle.preserveCaseShort'),
      active: toggleState.preserveCase,
      title: t('find.toggle.preserveCase'),
      ariaLabel: t('find.toggle.preserveCase'),
    })
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'F3') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    }
  }

  const inputTestId = `${testId}-input`

  return (
    <div
      data-testid={testId}
      className="flex flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)]">
        <Search size={13} className="text-[var(--color-text-tertiary)] shrink-0" />
        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder={placeholder ?? t('find.placeholder')}
          ariaLabel={t('find.placeholder')}
          testId={inputTestId}
          inputRef={inputRef}
          onKeyDown={onInputKeyDown}
          mainField={mainField}
          onClear={() => onQueryChange('')}
        />
        <IconToggleGroup
          items={items}
          onToggle={(key) => onToggle(key as FindToggleKey)}
          testId={`${testId}-toggles`}
        />
        <MatchCounter
          current={current}
          total={total}
          noneLabel={t('find.noResults')}
          testId={`${testId}-count`}
          onPrev={onPrev}
          onNext={onNext}
          prevLabel={t('find.prev')}
          nextLabel={t('find.next')}
        />
        <button
          type="button"
          data-testid={`${testId}-close`}
          aria-label={t('find.close')}
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-surface-overlay)] shrink-0"
        >
          <X size={13} />
        </button>
      </div>

      {showReplace && (
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <Replace size={13} className="text-[var(--color-text-tertiary)] shrink-0" />
          <input
            data-testid={`${testId}-replace`}
            value={replaceText}
            onChange={(e) => onReplaceTextChange?.(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('find.replacePlaceholder')}
            aria-label={t('find.replacePlaceholder')}
            className="flex-1 bg-transparent text-sm focus-ring text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]"
          />
          <button
            type="button"
            data-testid={`${testId}-replace-btn`}
            aria-label={t('find.replace')}
            onClick={onReplaceNext}
            disabled={!onReplaceNext}
            className="px-2 py-0.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-accent disabled:opacity-40"
          >
            {t('find.replace')}
          </button>
          <button
            type="button"
            data-testid={`${testId}-replace-all`}
            aria-label={t('find.replaceAll')}
            onClick={onReplaceAll}
            disabled={!onReplaceAll}
            className="px-2 py-0.5 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-accent disabled:opacity-40"
          >
            {t('find.replaceAll')}
          </button>
        </div>
      )}
    </div>
  )
}
