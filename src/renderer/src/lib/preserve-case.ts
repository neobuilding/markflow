// Preserve-case replacement, mirroring VS Code's "Preserve Case" (AB) toggle.
//
// Given the original matched text and the user's replacement, returns the
// replacement rewritten to follow the case shape of the original:
//   foo  → bar      (all lower)
//   Foo  → Bar      (title / first upper)
//   FOO  → BAR      (all upper)
//   fOO  → BaR? No — mixed case keeps the replacement verbatim.
//
// Exported for direct unit testing (the editor find widget reuses it for
// replace / replace-all).

function isAllLower(s: string): boolean {
  return s === s.toLowerCase() && s !== s.toUpperCase()
}

function isAllUpper(s: string): boolean {
  return s === s.toUpperCase() && s !== s.toLowerCase()
}

export function preserveCase(match: string, replacement: string): string {
  if (replacement === '' || match === '') return replacement
  if (isAllLower(match)) return replacement.toLowerCase()
  if (isAllUpper(match)) return replacement.toUpperCase()
  const first = match[0]
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase()
  }
  return replacement
}
