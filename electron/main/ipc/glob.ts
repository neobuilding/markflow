import picomatch from 'picomatch'

// Filename-mode search routes through picomatch (the same matcher VS Code's file search
// uses) instead of the full-text index. This keeps "file name" search about paths, not
// content, and lets users type real globs like `*.md`, `src/**/*.ts`, `note[1-3].md`.
//
// `*` matches within a single path segment (so `*.md` matches `meeting.md` but not
// `sub/meeting.md`); `**` crosses directories; `?` `[...]` `{}` work as expected.

// Detect whether a query contains glob metacharacters. When it does, filename-mode search
// switches from a plain case-insensitive substring match to a picomatch glob over each
// document's path relative to the active folder.
export function hasGlobMeta(query: string): boolean {
  // Q15 lists the trigger metacharacters as `* ? [ {`. The closing `]` and `}` are NOT
  // triggers: they are ordinary characters on their own (they only mean something once a
  // matching `[` / `{` opens a group, and that opening character is already in the set).
  return /[*?[{]+/.test(query)
}

// Match a file path (expected forward-slash separated, relative to the active folder, no
// leading slash) against a glob pattern.
// - `dot: true` lets `*.ts` also match `.gitignore`.
// - `nocase: true` makes every query case-insensitive (Q15: unified case-insensitivity), so a
//   pattern with literal letters like `report*` still matches `Report.md`.
// - `basename: !query.includes('/')` implements Q8's matchBase rule: a pattern WITHOUT a slash
//   matches the file *name* at ANY depth (`*.md` matches `sub/meeting.md`), while a pattern WITH
//   a slash (or `**`) matches the path relative to the active folder (`notes/*`, `**/*.md`).
// Invalid patterns return false rather than throwing.
export function globMatch(relativePath: string, query: string): boolean {
  try {
    return picomatch.isMatch(relativePath, query, {
      dot: true,
      nocase: true,
      basename: !query.includes('/'),
    })
  } catch {
    // Defensive: picomatch tolerates arbitrary patterns (verified for '[', '{a,b', '[a-',
    // '**{'), returning false instead of throwing, so this branch is never reached from the
    // UI. Kept so a future picomatch change can't crash the whole search handler.
    /* v8 ignore next -- defensive: picomatch returns false for malformed patterns rather than throwing */
    return false
  }
}
