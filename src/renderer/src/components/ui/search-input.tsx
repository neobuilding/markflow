import React from 'react'
import { X } from 'lucide-react'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  testId: string
  inputRef?: React.Ref<HTMLInputElement>
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  // When true, tag the input with `main-field="true"` so CodeMirror's panel
  // focuses it automatically on open (editor find widget only).
  mainField?: boolean
  onClear?: () => void
}

// Shared single-line search input with a clear (✕) button that appears only when there is
// text. Used by the editor/preview find widgets and the sidebar search panel so every search
// surface shares one visual language.
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
  inputRef,
  onKeyDown,
  mainField = false,
  onClear,
}: SearchInputProps): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <input
        ref={inputRef}
        data-testid={testId}
        {...(mainField ? { 'main-field': 'true' } : {})}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full bg-transparent text-sm outline-none text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]"
      />
      {value && onClear && (
        <button
          type="button"
          data-testid={`${testId}-clear`}
          aria-label={ariaLabel}
          onClick={onClear}
          className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] shrink-0"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
