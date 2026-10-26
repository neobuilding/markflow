import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, ChevronDown, ChevronRight, Replace, Undo2 } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { useSearchView } from '../../hooks/useSearch'
import { useT, type TranslationKey } from '../../i18n'
import { InputContextMenu } from '../ui/input-context-menu'
import { ContentResultList } from '../editor/SearchResults'
import { flattenHitOrder } from '../../lib/search-hits'

import { IconToggleGroup } from '../ui/icon-toggle-group'
import type { HitItem } from '../../lib/search-hits'
import type { ReplaceSkipReason } from '../../types'

interface PlanState {
  planId: string
  fileCount: number
  matchCount: number
  // The plan's skip diagnostics travel with it (D28 / ADR-0023 item 15): a replace that dropped
  // files has to SAY which and why, instead of quietly writing fewer files than the user counted.
  skipped: Array<{ documentId: string; relPath: string; reason: ReplaceSkipReason }>
}

// Which skip reasons are worth a line in the panel. `no-hit` is not one of them — a file without
// the needle is the normal case, not something the user has to be told about.
function skipNote(
  skipped: PlanState['skipped'],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string | null {
  const notes: string[] = []
  if (skipped.some((s) => s.reason === 'unsaved')) notes.push(t('search.dirtyBufferSkipped'))
  if (skipped.some((s) => s.reason === 'out-of-root')) notes.push(t('search.outOfRootSkipped'))
  return notes.length > 0 ? notes.join(' · ') : null
}

// The Search view: Markdown BODY search with a visible, path-expressed scope and cross-file
// replace (ADR-0023). It is the only surface that has a scope or a replace — Quick Open (Ctrl+K)
// is file names only, and that split is the whole point of D1.
export function SidebarSearch(): React.ReactElement {
  const { t } = useT()
  const searchQuery = useUIStore((s) => s.searchQuery)
  const setSearchQuery = useUIStore((s) => s.setSearchQuery)
  const searchInclude = useUIStore((s) => s.searchInclude)
  const setSearchInclude = useUIStore((s) => s.setSearchInclude)
  const searchExclude = useUIStore((s) => s.searchExclude)
  const setSearchExclude = useUIStore((s) => s.setSearchExclude)
  const searchMatchCase = useUIStore((s) => s.searchMatchCase)
  const setSearchMatchCase = useUIStore((s) => s.setSearchMatchCase)
  const searchWholeWord = useUIStore((s) => s.searchWholeWord)
  const setSearchWholeWord = useUIStore((s) => s.setSearchWholeWord)
  const searchRegexp = useUIStore((s) => s.searchRegexp)
  const setSearchRegexp = useUIStore((s) => s.setSearchRegexp)
  const searchReplaceText = useUIStore((s) => s.searchReplaceText)
  const setSearchReplaceText = useUIStore((s) => s.setSearchReplaceText)
  const searchReplaceOpen = useUIStore((s) => s.searchReplaceOpen)
  const setSearchReplaceOpen = useUIStore((s) => s.setSearchReplaceOpen)
  const searchDetailsOpen = useUIStore((s) => s.searchDetailsOpen)
  const setSearchDetailsOpen = useUIStore((s) => s.setSearchDetailsOpen)
  const selectDocument = useUIStore((s) => s.selectDocument)
  const openDocumentAt = useUIStore((s) => s.openDocumentAt)
  const setFileDetailsId = useUIStore((s) => s.setFileDetailsId)

  const { data, isFetching } = useSearchView()
  const inputRef = useRef<HTMLInputElement>(null)
  const includeRef = useRef<HTMLInputElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [planning, setPlanning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelTokenRef = useRef<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // A global shortcut (Ctrl+Shift+F) opens this view and bumps a nonce; grab the input so
  // the user can type immediately without clicking (ADR-0023). Deferred to the next frame so it
  // runs after the input has been committed to the DOM (it only mounts when the view switches).
  const searchFocusNonce = useUIStore((s) => s.searchFocusNonce)
  useEffect(() => {
    if (searchFocusNonce <= 0) return
    const el = inputRef.current
    if (!el) return
    const id = requestAnimationFrame(() => el.focus())
    return () => cancelAnimationFrame(id)
  }, [searchFocusNonce])

  // "Search in This Folder" (tree context menu) writes the include value from the other side of
  // the component boundary; focus the row it just filled so the value can be edited in place.
  // Deferred a frame because the row only mounts once the details block is open (ADR-0023 D8).
  const searchScopeFocusNonce = useUIStore((s) => s.searchScopeFocusNonce)
  const detailsOpen = useUIStore((s) => s.searchDetailsOpen)
  useEffect(() => {
    if (searchScopeFocusNonce <= 0) return
    const el = includeRef.current
    if (!el) return
    const id = requestAnimationFrame(() => el.focus())
    return () => cancelAnimationFrame(id)
  }, [searchScopeFocusNonce, detailsOpen])

  const results = data.results
  const activeFolder = useUIStore((s) => s.activeFolder)
  // The scope inputs are meaningful only when a workspace root exists. That is whether the user has
  // opened a folder (the renderer mirrors the main-process root in `activeFolder`), so read it from
  // there — NOT from `data.appliedScope.root`, which is unknown until a search actually runs (and a
  // search never runs for an empty query, which would wrongly leave the inputs disabled).
  const scopeDisabled = activeFolder === null
  // A non-empty scope must never be hidden — the whole complaint that started this plan was a
  // scope the user could not see.
  const detailsVisible =
    searchDetailsOpen || searchInclude.trim() !== '' || searchExclude.trim() !== ''

  const multiline = /[\r\n]/.test(searchQuery)

  const navItems = useMemo<HitItem[]>(() => flattenHitOrder(results, 'content'), [results])

  const resetKey = `${searchQuery}|${searchInclude}|${searchExclude}|${searchMatchCase}|${
    searchWholeWord
  }|${searchRegexp}|${results.length}|${results[0]?.documentId ?? ''}`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey)
    setSelectedIndex(0)
  }

  // Any change to the query / scope / replacement invalidates a plan: the count the user saw is no
  // longer the count that would be written (D29). The MATCH SEMANTICS belong in that set too —
  // regex and whole-word change what counts as a hit, so a plan made under different flags is not
  // the plan the user confirmed (§13.8). Guarded so the mount run is a no-op — clearing
  // state that is already null would only force an extra render.
  const planInputs = `${searchQuery}|${searchInclude}|${searchExclude}|${searchMatchCase}|${searchWholeWord}|${searchRegexp}|${searchReplaceText}`
  const planInputsRef = useRef(planInputs)
  useEffect(() => {
    if (planInputsRef.current === planInputs) return
    planInputsRef.current = planInputs
    setPlan(null)
  }, [planInputs])

  // Progress is PUSHED while the plan runs (see ipc/replace.ts).
  useEffect(() => {
    if (!planning) return
    return window.api.onReplaceProgress((p) => {
      if (p.cancelToken === cancelTokenRef.current) setProgress({ done: p.done, total: p.total })
    })
  }, [planning])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(navItems.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const item = navItems[selectedIndex]
      if (!item) return
      if (item.start !== undefined && item.end !== undefined) {
        void openDocumentAt(item.id, item.start, item.end)
      } else {
        void selectDocument(item.id)
      }
    }
  }

  const dirtyState = () => {
    const { unsavedBuffers, documentStateRevision } = useUIStore.getState()
    return {
      unsavedDocumentIds: Object.keys(unsavedBuffers),
      documentStateRevision,
    }
  }

  const runPlan = async (
    target?: { documentId: string } | { documentId: string; matchStartUtf16: number },
  ): Promise<PlanState | null> => {
    if (!searchQuery.trim()) return null
    setNotice(null)
    const token = crypto.randomUUID()
    cancelTokenRef.current = token
    setPlanning(true)
    setProgress(null)
    try {
      const outcome = await window.api.replace.plan({
        query: searchQuery,
        replaceText: searchReplaceText,
        include: searchInclude,
        exclude: searchExclude,
        matchCase: searchMatchCase,
        wholeWord: searchWholeWord,
        regexp: searchRegexp,
        target,
        ...dirtyState(),
        cancelToken: token,
      })
      if (!outcome.ok) {
        if (outcome.reason === 'invalid-pattern' && outcome.diagnostic) {
          setNotice(
            t('search.invalidPattern', {
              field: outcome.diagnostic.field ?? '',
              pattern: outcome.diagnostic.pattern ?? '',
            }),
          )
        } else if (outcome.reason === 'aborted' && outcome.aborted) {
          // Name the offenders: "cancelled" alone gives the user nothing to narrow by (D18).
          setNotice(
            t('search.replaceAborted', {
              limit: outcome.aborted.limit,
              offending: outcome.aborted.offending.slice(0, 5).join(', '),
            }),
          )
        } else if (outcome.reason === 'no-workspace-root') {
          setNotice(t('search.replaceNoRootDrafts'))
        } else {
          setNotice(t('search.replaceCancelled'))
        }
        return null
      }
      const next: PlanState = {
        planId: outcome.plan.planId,
        fileCount: outcome.plan.fileCount,
        matchCount: outcome.plan.matchCount,
        skipped: outcome.plan.skipped,
      }
      setPlan(next)
      return next
    } finally {
      setPlanning(false)
      setProgress(null)
      cancelTokenRef.current = null
    }
  }

  const applyPlan = async (planned: PlanState) => {
    const ok = await window.api.dialog.confirm({
      message: t('search.replaceAllConfirm', {
        count: planned.matchCount,
        files: planned.fileCount,
        replacement: searchReplaceText,
      }),
      okText: t('search.replace'),
      cancelText: t('app.cancel'),
    })
    if (!ok) return
    const outcome = await window.api.replace.apply({
      planId: planned.planId,
      ...dirtyState(),
    })
    setPlan(null)
    if (!outcome.ok) {
      setNotice(t('search.replaceCancelled'))
      return
    }
    const failed = outcome.files.filter((f) => f.status !== 'ok')
    setNotice(
      failed.length === 0
        ? t('search.replaceResult', { count: outcome.replaced, files: outcome.files.length })
        : t('search.replaceFailures', { count: failed.length }),
    )
  }

  const replaceAll = async () => {
    const planned = await runPlan()
    if (planned && planned.matchCount > 0) await applyPlan(planned)
  }

  const replaceInFile = async () => {
    const item = navItems[selectedIndex]
    if (!item) return
    const planned = await runPlan({ documentId: item.id })
    if (planned && planned.matchCount > 0) await applyPlan(planned)
  }

  const replaceHere = async () => {
    const item = navItems[selectedIndex]
    if (!item || item.start === undefined) return
    const planned = await runPlan({ documentId: item.id, matchStartUtf16: item.start })
    if (planned && planned.matchCount > 0) await applyPlan(planned)
  }

  const undoReplace = async () => {
    const outcome = await window.api.replace.undo()
    setNotice(
      outcome.ok
        ? t('search.undoResult', { count: outcome.restored })
        : t('search.undoUnavailable'),
    )
  }

  const blocking = data.diagnostics.find((d) => d.blocking)
  // Non-blocking diagnostics explain WHY the result set looks the way it does (drafts excluded by
  // a scope, root-external documents skipped, display caps). They are information, not errors, and
  // must stay visible: a scope whose side effects cannot be audited is exactly what this plan
  // outlawed (D19 / §5.2). The main-process `message` stays in the contract as the `title`.
  const nonBlocking = data.diagnostics.filter((d) => !d.blocking)
  // Same rule for replace: the plan names the files it dropped, and dropping one silently would
  // make the confirmed count a lie (D28 / ADR-0023 item 15).
  const planSkipNote = plan && !planning ? skipNote(plan.skipped, t) : null

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-3 pt-2 pb-2 shrink-0">
        <div
          data-testid="resident-search-box"
          className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-accent transition-colors"
        >
          <Search size={13} className="text-[var(--color-text-tertiary)] shrink-0" />
          <InputContextMenu targetRef={inputRef}>
            <input
              ref={inputRef}
              data-testid="resident-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('sidebar.searchPanel')}
              aria-label={t('sidebar.searchPanel')}
              className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none min-w-0"
            />
          </InputContextMenu>
          {searchQuery && (
            <button
              type="button"
              data-testid="resident-search-clear"
              onClick={() => setSearchQuery('')}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] shrink-0"
              aria-label={t('find.close')}
            >
              <X size={13} />
            </button>
          )}
          {/* Match Case (`Aa`) / Whole word (`ab`) / Regexp (`.*`). All three default OFF and all
              three go through the shared toggle atom, so the Search view speaks the same visual and
              aria language as the editor and preview find widgets (ADR-0013 Q1, §13.9). */}
          <IconToggleGroup
            testId="search-match-case"
            onToggle={(key) => {
              if (key === 'Aa') setSearchMatchCase(!searchMatchCase)
              else if (key === 'ab') setSearchWholeWord(!searchWholeWord)
              else if (key === '.*') setSearchRegexp(!searchRegexp)
            }}
            items={[
              {
                key: 'Aa',
                label: 'Aa',
                active: searchMatchCase,
                title: t('search.matchCase'),
                ariaLabel: t('search.matchCase'),
              },
              {
                key: 'ab',
                label: 'ab',
                active: searchWholeWord,
                title: t('search.wholeWord'),
                ariaLabel: t('search.wholeWord'),
              },
              {
                key: '.*',
                label: '.*',
                active: searchRegexp,
                title: t('search.regexp'),
                ariaLabel: t('search.regexp'),
              },
            ]}
          />
          <button
            type="button"
            data-testid="search-toggle-replace"
            aria-expanded={searchReplaceOpen}
            title={t('search.toggleReplace')}
            aria-label={t('search.toggleReplace')}
            onClick={() => setSearchReplaceOpen(!searchReplaceOpen)}
            className="shrink-0 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          >
            {searchReplaceOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        </div>

        {searchReplaceOpen && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <input
              data-testid="search-replace-input"
              value={searchReplaceText}
              onChange={(e) => setSearchReplaceText(e.target.value)}
              placeholder={t('search.replacePlaceholder')}
              aria-label={t('search.replacePlaceholder')}
              className="flex-1 h-7 px-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-sm outline-none min-w-0"
            />
            <button
              type="button"
              data-testid="search-replace-here"
              disabled={planning || !searchQuery}
              onClick={() => void replaceHere()}
              className="shrink-0 px-1.5 h-7 rounded border border-[var(--color-border)] text-2xs text-[var(--color-text-secondary)] disabled:opacity-40"
            >
              {t('search.replaceHere')}
            </button>
            <button
              type="button"
              data-testid="search-replace-in-file"
              disabled={planning || !searchQuery}
              onClick={() => void replaceInFile()}
              className="shrink-0 px-1.5 h-7 rounded border border-[var(--color-border)] text-2xs text-[var(--color-text-secondary)] disabled:opacity-40"
            >
              {t('search.replaceInFile')}
            </button>
            <button
              type="button"
              data-testid="search-replace-all"
              disabled={planning || !searchQuery}
              onClick={() => void replaceAll()}
              className="shrink-0 px-1.5 h-7 rounded border border-[var(--color-border)] text-2xs text-[var(--color-text-secondary)] disabled:opacity-40"
            >
              {t('search.replaceAll')}
            </button>
          </div>
        )}

        <button
          type="button"
          data-testid="search-toggle-details"
          aria-expanded={detailsVisible}
          onClick={() => setSearchDetailsOpen(!detailsVisible)}
          className="flex items-center gap-1 mt-1.5 text-2xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
        >
          {detailsVisible ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {t('search.toggleDetails')}
        </button>

        {detailsVisible && (
          <div className="mt-1 space-y-1">
            <ScopeRow
              inputRef={includeRef}
              testId="search-include"
              label={t('search.include')}
              placeholder={t('search.includePlaceholder')}
              value={searchInclude}
              disabled={scopeDisabled}
              title={scopeDisabled ? t('search.scopeDisabledNoRoot') : undefined}
              clearLabel={t('search.clear')}
              onChange={setSearchInclude}
            />
            <ScopeRow
              testId="search-exclude"
              label={t('search.exclude')}
              placeholder={t('search.excludePlaceholder')}
              value={searchExclude}
              disabled={scopeDisabled}
              title={scopeDisabled ? t('search.scopeDisabledNoRoot') : undefined}
              clearLabel={t('search.clear')}
              onChange={setSearchExclude}
            />
          </div>
        )}
      </div>

      {multiline && (
        <div
          data-testid="search-multiline"
          className="px-3 pb-2 text-2xs text-[var(--color-text-tertiary)]"
        >
          {t('search.multilineUnsupported')}
        </div>
      )}

      {searchRegexp && !multiline && (
        // `.*` mode: the escape and the anchoring rule are the two things a user coming from a
        // different engine would get wrong, so they are stated inline (§13.9).
        <div
          data-testid="search-regex-hint"
          className="px-3 pb-2 text-2xs text-[var(--color-text-tertiary)]"
        >
          {t('search.regexHint')}
        </div>
      )}

      {blocking && (
        <div
          data-testid="search-diagnostic"
          role="alert"
          className="mx-3 mb-2 px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs text-[var(--color-text-secondary)]"
        >
          {blocking.code === 'invalid-regex'
            ? t('search.invalidRegex', { message: blocking.message })
            : blocking.code === 'regex-timeout'
              ? t('search.regexTimeout')
              : blocking.code === 'path-not-found'
                ? t('search.pathNotFound', { pattern: blocking.pattern ?? '' })
                : t('search.invalidPattern', {
                    field: blocking.field ?? '',
                    pattern: blocking.pattern ?? '',
                  })}
        </div>
      )}

      {nonBlocking.length > 0 && (
        <div
          data-testid="search-diagnostic-info"
          role="status"
          className="mx-3 mb-2 px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs text-[var(--color-text-tertiary)] space-y-0.5"
        >
          {nonBlocking.map((d, i) => (
            <div key={`${d.code}-${i}`} title={d.message}>
              {d.code === 'drafts-excluded'
                ? t('search.draftsExcluded')
                : d.code === 'out-of-root-skipped'
                  ? t('search.outOfRootSkipped')
                  : d.code === 'match-cap'
                    ? t('search.matchCap')
                    : d.code === 'doc-cap'
                      ? t('search.docCap')
                      : d.message}
            </div>
          ))}
        </div>
      )}

      {notice && (
        <div
          data-testid="search-notice"
          role="status"
          className="mx-3 mb-2 px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-2xs text-[var(--color-text-secondary)]"
        >
          {notice}
        </div>
      )}

      {planning && (
        <div
          data-testid="search-replace-progress"
          className="mx-3 mb-2 flex items-center gap-2 text-2xs text-[var(--color-text-tertiary)]"
        >
          <span>{progress ? `${progress.done}/${progress.total}` : t('search.planning')}</span>
          <button
            type="button"
            data-testid="search-replace-cancel"
            onClick={() => {
              if (cancelTokenRef.current) void window.api.replace.cancel(cancelTokenRef.current)
            }}
            className="px-1 py-0.5 rounded border border-[var(--color-border)]"
          >
            {t('app.cancel')}
          </button>
        </div>
      )}

      {plan && !planning && (
        <div
          data-testid="search-replace-plan"
          className="mx-3 mb-2 text-2xs text-[var(--color-text-tertiary)]"
        >
          {t('search.replaceAllConfirm', {
            count: plan.matchCount,
            files: plan.fileCount,
            replacement: searchReplaceText,
          })}
          {planSkipNote !== null && (
            <div data-testid="search-replace-skipped" className="mt-0.5">
              {planSkipNote}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--color-border)]">
        {isFetching && searchQuery && (
          <div className="px-4 py-3 text-sm text-[var(--color-text-tertiary)]">
            {t('palette.searching')}
          </div>
        )}
        {!isFetching && searchQuery && results.length === 0 && !blocking && (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
            {t('search.noResults')}
          </div>
        )}
        {!searchQuery && (
          <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">
            {t('palette.startTyping')}
          </div>
        )}
        {results.length > 0 && (
          <ContentResultList
            results={results}
            selectedIndex={selectedIndex}
            onSelectIndex={setSelectedIndex}
            onSelect={(id) => void selectDocument(id)}
            onSelectMatch={(id, start, end) => void openDocumentAt(id, start, end)}
            onShowDetails={setFileDetailsId}
          />
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-[var(--color-border)] text-2xs text-[var(--color-text-tertiary)] shrink-0">
        <Replace size={11} />
        <button
          type="button"
          data-testid="search-undo-replace"
          onClick={() => void undoReplace()}
          className="flex items-center gap-1 hover:text-[var(--color-text-secondary)]"
        >
          <Undo2 size={11} /> {t('search.undoReplace')}
        </button>
      </div>
    </div>
  )
}

function ScopeRow({
  inputRef,
  testId,
  label,
  placeholder,
  value,
  disabled,
  title,
  clearLabel,
  onChange,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>
  testId: string
  label: string
  placeholder: string
  value: string
  disabled: boolean
  title?: string
  clearLabel: string
  onChange: (v: string) => void
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <span className="w-8 shrink-0 text-2xs text-[var(--color-text-tertiary)]">{label}</span>
      <input
        ref={inputRef ?? undefined}
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="flex-1 h-6 px-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-2xs outline-none min-w-0 disabled:opacity-50"
      />
      {value && (
        <button
          type="button"
          data-testid={`${testId}-clear`}
          aria-label={clearLabel}
          onClick={() => onChange('')}
          className="shrink-0 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
