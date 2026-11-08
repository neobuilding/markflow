// Guard test: renderer components must never subscribe to the WHOLE UI store.
//
// In zustand v5 `useStore(api, selector = identity)` defaults to an identity selector, so a bare
// `useUIStore()` returns a fresh state object on every `setState` and React re-renders the
// component. ADR-0033 deliberately writes the unsaved-buffer registry on the KEYSTROKE FRAME,
// which means one such write per character. With five identity-selector subscribers that re-render
// the app shell, the editor pane and the sidebar, typing 24 characters into a 952-block document
// cost ~340ms extra and turned `e2e-perf-gate` red on the slower CI runner.
//
// Field-scoped selectors keep every state semantic intact (the registry is still written per
// keystroke) while making those writes invisible to unrelated components. This is a static guard
// rather than a render-count test because the regression is invisible in any single UI assertion:
// everything still LOOKS right, it is just slow. See `src/renderer/src/store/ui.test.tsx` for the
// behavioural counterpart (a selector-scoped hook does not re-render on a registry write).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './repo'
const RENDERER_SRC = join(ROOT, 'src', 'renderer', 'src')

/** Every renderer source file, recursively. Test files are included: they must follow the rule too. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

/** A comment explaining this rule must not be mistaken for a violation. */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

/** The five components that used to subscribe with an identity selector (ADR-0033 regression). */
const SUBSCRIBED_COMPONENTS = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/editor/EditorPane.tsx',
  'src/renderer/src/components/sidebar/Sidebar.tsx',
  'src/renderer/src/components/editor/CommandPalette.tsx',
  'src/renderer/src/components/editor/NewDocumentDialog.tsx',
]

describe('renderer UI store subscriptions', () => {
  it('never subscribes to the whole store with an identity selector', () => {
    // `= useUIStore()` also catches the multi-line destructuring form `} =\n  useUIStore()`.
    // `.getState()` / `.subscribe()` are imperative reads and are deliberately allowed.
    const files = sourceFiles(RENDERER_SRC)
    expect(files.length, 'the renderer source scan must find files').toBeGreaterThan(0)
    const offenders = files.filter((file) =>
      /=\s*useUIStore\(\s*\)/.test(withoutComments(readFileSync(file, 'utf-8'))),
    )
    expect(
      offenders.map((file) => file.slice(ROOT.length + 1)),
      'use one field-scoped selector per value instead',
    ).toEqual([])
  })

  it.each(SUBSCRIBED_COMPONENTS)('%s keeps its field-scoped subscriptions', (relPath) => {
    // Dropping the subscription entirely would freeze real UI (theme, view mode, active folder…),
    // so the guard also pins that each of these components still subscribes to individual fields.
    const source = readFileSync(join(ROOT, relPath), 'utf-8')
    expect(source).toMatch(/useUIStore\(\(s\) => s\./)
  })

  it('never returns a fresh object literal from a selector', () => {
    // zustand v5 + React 19 compare snapshots with Object.is. A selector that builds a new object
    // on every call reports "getSnapshot should be cached" and can loop forever. Use one primitive
    // selector per field instead (or `useShallow`, which this repo has no precedent for).
    const files = sourceFiles(RENDERER_SRC)
    expect(files.length, 'the renderer source scan must find files').toBeGreaterThan(0)
    const offenders = files.filter((file) =>
      /useUIStore\(\s*\(\s*\w+\s*\)\s*=>\s*\(\s*\{/.test(
        withoutComments(readFileSync(file, 'utf-8')),
      ),
    )
    expect(
      offenders.map((file) => file.slice(ROOT.length + 1)),
      'use one primitive selector per field (or useShallow)',
    ).toEqual([])
  })

  it('keeps the editor selection offset referentially stable', () => {
    // A fresh object on every render used to re-run MarkdownEditor's full-document sync effect
    // while a search jump was pending (Vercel rerender-dependencies).
    const source = readFileSync(
      join(ROOT, 'src/renderer/src/components/editor/EditorPane.tsx'),
      'utf-8',
    )
    expect(source, 'selectionOffset must be memoised on [pendingMatch]').toMatch(
      /const selectionOffset = useMemo\(/,
    )
  })
})
