// The body of the regex-scan Worker (ADR-0023 D37).
//
// Why a thread at all: JS regular expressions are BACKTRACKING and cannot be interrupted while
// they run — `AbortController` has no reach into `RegExp.prototype.exec`. A pathological pattern
// such as `(a+)+b` against a long run of `a` therefore cannot be cancelled, timed out or
// cooperatively stopped; it simply occupies the thread until the backtracking finishes. Running
// user-supplied regexes on the main process thread would let one keystroke freeze the whole app.
// The only remedy in JS is to run them somewhere that can be destroyed from outside, which is a
// Worker thread plus `terminate()`.
//
// VS Code gets the same protection for free from its architecture: its search runs in a separate
// process and its engine (ripgrep) is a finite automaton, so it is linear-time and cannot
// backtrack at all. Neither is available here, hence the thread.
//
// Literal (default) search deliberately does NOT come through here: it is `indexOf`-based and
// linear, so it has nothing to gain and would only pay the round trip.
import { parentPort } from 'node:worker_threads'
import { createScanner } from '../lib/content-match'
import type { MatchOptions } from '../lib/content-match'
import type { SearchMatch } from '../../../shared/searchTypes'

export interface RegexScanRequest {
  query: string
  opts: MatchOptions
  /** Display cap per document (MAX_MATCHES_PER_DOC). Counting is never capped. */
  max: number
  /** One entry per candidate document, in the caller's order. */
  contents: string[]
}

export interface RegexScanItem {
  matches: SearchMatch[]
  total: number
  capped: boolean
}

export type RegexScanResponse =
  { ok: true; results: RegexScanItem[] } | { ok: false; message: string }

const EMPTY: RegexScanItem = { matches: [], total: 0, capped: false }

export function handleRegexScanRequest(req: RegexScanRequest): RegexScanResponse {
  const compiled = createScanner(req.query, req.opts)
  if (!compiled.ok) return { ok: false, message: compiled.message }
  const factory = compiled.factory
  return {
    ok: true,
    results: req.contents.map((content) =>
      content ? factory.scan(content, req.max) : { ...EMPTY },
    ),
  }
}

// Only meaningful inside a real Worker thread; under vitest there is no parent port, so the
// registration is excluded from coverage (the same treatment `ui.ts` gives `import.meta.env.DEV`).
/* v8 ignore next 3 */
if (parentPort) {
  parentPort.on('message', (req: RegexScanRequest) => {
    parentPort!.postMessage(handleRegexScanRequest(req))
  })
}
