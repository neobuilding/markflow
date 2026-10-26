// Cross-file replace: plan → confirm → write → undo (ADR-0023).
//
// This is a SERVICE, not an IPC handler: everything below is driven through injected dependencies
// so it can be exercised against the in-memory DiskIO fake and a seeded document store, which is
// what makes "zero writes when a budget trips" and "zero writes when cancelled" assertable at all.
//
// Three invariants the shape of this module exists to protect:
//
//  1. A safety-budget breach or a cancellation means ZERO writes — not a truncated batch. A
//     half-applied rename across a thousand Markdown files is unrecoverable by hand.
//  2. The plan is asynchronous and file-at-a-time, so a large workspace cannot freeze the main
//     process, and a cancel request can actually stop it (a `cancelToken` in the request payload
//     alone cannot: IPC is a one-way request, see ADR-0023).
//  3. A planId is single-use and bound to everything that made it: root, session, query,
//     replacement, scope, matchCase and the dirty-state revision. Replaying it would decouple
//     "the count the user confirmed" from "the bytes actually written".
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import iconv from 'iconv-lite'
import { buildScope, inScope, relToRoot } from '../lib/scope-filter'
import { createScanner, type MatchOptions } from '../lib/content-match'
import { sha256 } from '../lib/hash'
import type { DiskIO } from '../lib/disk-io'
import type { Document } from '../model/documentStore'
import type {
  ReplaceApplyOptions,
  ReplaceApplyOutcome,
  ReplaceFileOutcome,
  ReplacePlanOptions,
  ReplacePlanOutcome,
  ReplacePlanSummary,
  ReplaceSkipReason,
  ReplaceUndoOutcome,
  SearchDiagnostic,
} from '../../../shared/searchTypes'

// ─── Safety budget (ADR-0023) ─────────────────────────────────────────────────────────────
//
// Deliberately CONSTANTS, not settings. No editor exposes batch-write safety thresholds to users:
// writing to disk is destructive, so "let me raise the limit to 1,000,000" is an accident waiting
// to happen. The supported way to replace across a huge workspace is to narrow `include` and run
// several smaller batches.
export const MAX_REPLACE_FILES = 1000
export const MAX_REPLACE_TOTAL_INPUT_BYTES = 64 * 1024 * 1024
export const MAX_REPLACE_FILE_BYTES = 16 * 1024 * 1024
export const MAX_REPLACE_OUTPUT_BYTES = 128 * 1024 * 1024
export const MAX_REPLACE_COUNT = 100_000

export type BudgetLimit = 'files' | 'input-bytes' | 'file-bytes' | 'output-bytes' | 'count'

export interface ReplaceDeps {
  io: DiskIO
  /** All documents currently in the store. */
  getDocuments: () => Document[]
  getRoot: () => string | null
  getSession: () => number
  /** Suppress the watcher echo for our own writes (`folderWatcher.markOwnWrite`). */
  markOwnWrite: (filePath: string) => void
  /** Reflect the new bytes back into the store, which the watcher echo will not do. */
  applyToStore: (documentId: string, content: string) => void
}

// ─── BOM handling ──────────────────────────────────────────────────────────────────────────────
//
// `documents:update` writes `iconv.encode(text)` straight over the file, so a BOM is lost today.
// Replace must not add a second regression of the same kind: the BOM is sniffed off the bytes we
// read and re-prefixed on the way out.
const BOMS: Array<{ bytes: number[]; encoding: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

function splitBom(buf: Buffer): { bom: Buffer; body: Buffer } {
  for (const candidate of BOMS) {
    if (buf.length < candidate.bytes.length) continue
    let ok = true
    for (let i = 0; i < candidate.bytes.length; i++) {
      if (buf[i] !== candidate.bytes[i]) {
        ok = false
        break
      }
    }
    if (ok)
      return {
        bom: buf.subarray(0, candidate.bytes.length),
        body: buf.subarray(candidate.bytes.length),
      }
  }
  return { bom: Buffer.alloc(0), body: buf }
}

// iconv-lite substitutes '?' rather than throwing, so losslessness is checked by round-tripping:
// encode → decode → compare. A replacement string the file's encoding cannot represent must skip
// the file, never silently degrade into mojibake.
function encodeLossless(text: string, encoding: string): Buffer | null {
  const buf = iconv.encode(text, encoding)
  if (iconv.decode(buf, encoding) !== text) return null
  return buf
}

// ─── Plan bookkeeping ──────────────────────────────────────────────────────────────────────────

interface PlanFile {
  documentId: string
  filePath: string
  relPath: string
  encoding: string
  bom: Buffer
  baselineHash: string
  newText: string
  matchCount: number
  outputBytes: number
}

interface PlanRecord {
  planId: string
  root: string | null
  session: number
  query: string
  replaceText: string
  include: string
  exclude: string
  matchCase: boolean
  /** Recorded so a plan can never be applied under match semantics other than the ones it was
   *  computed with (§13.8): the bytes were already produced by that exact matcher. */
  regexp: boolean
  wholeWord: boolean
  revision: number
  unsaved: string[]
  files: PlanFile[]
  applied: boolean
}

const plans = new Map<string, PlanRecord>()
/** cancelToken → controller, so `search:replace:cancel` can actually stop a running scan. */
const running = new Map<string, AbortController>()

interface UndoEntry {
  filePath: string
  documentId: string
  encoding: string
  bom: Buffer
  before: Buffer
  afterHash: string
}
let lastTransaction: { root: string | null; session: number; files: UndoEntry[] } | null = null

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export type ReplaceProgressCallback = (done: number, total: number) => void

// ─── plan ─────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  doc: Document
  rel: string
  reason?: ReplaceSkipReason
}

// Phase 1: metadata-only filtering, zero I/O. Cheap skips must not read the file, and must not
// consume any of the safety budget.

// Real-path containment (§5.5.3): a symlink INSIDE the root can point OUTSIDE it, and a write must
// never follow it out. Lexical containment (relToRoot, phase 1) cannot see through links, so this
// runs in phase 2, where the file is already open — and before any budget is consumed, because a
// skipped file writes nothing.
function escapesRootViaSymlink(filePath: string, realRoot: string): boolean {
  try {
    const real = realpathSync(filePath)
    return real !== realRoot && !real.startsWith(realRoot + sep)
  } catch {
    // Vanished or unresolvable: phase 2's readFile above has already classified whatever is
    // wrong with the path. Never fail the whole plan over a resolution error.
    return false
  }
}

function collectCandidates(
  docs: Document[],
  root: string | null,
  scope: ReturnType<typeof buildScope>['scope'],
  unsaved: Set<string>,
  targetId: string | null,
): {
  candidates: Candidate[]
  skipped: Array<{ documentId: string; relPath: string; reason: ReplaceSkipReason }>
} {
  const candidates: Candidate[] = []
  const skipped: Array<{ documentId: string; relPath: string; reason: ReplaceSkipReason }> = []
  for (const doc of docs) {
    if (targetId && doc.id !== targetId) continue
    if (doc.memoryOnly || !doc.filePath) {
      skipped.push({ documentId: doc.id, relPath: doc.title, reason: 'memory-only' })
      continue
    }
    const rel = relToRoot(doc.filePath, root)
    if (rel === null) {
      skipped.push({ documentId: doc.id, relPath: doc.filePath, reason: 'out-of-root' })
      continue
    }
    if (unsaved.has(doc.id)) {
      skipped.push({ documentId: doc.id, relPath: rel, reason: 'unsaved' })
      continue
    }
    if (!inScope(rel, scope)) continue // out of scope is not a "skip", it is simply not a candidate
    candidates.push({ doc, rel })
  }
  return { candidates, skipped }
}

export async function planReplace(
  options: ReplacePlanOptions,
  deps: ReplaceDeps,
  onProgress?: ReplaceProgressCallback,
): Promise<ReplacePlanOutcome> {
  const query = options?.query ?? ''
  const replaceText = options?.replaceText
  if (!query) return { ok: false, reason: 'empty-query' }
  if (typeof replaceText !== 'string') return { ok: false, reason: 'empty-query' }
  if (
    !Array.isArray(options.unsavedDocumentIds) ||
    typeof options.documentStateRevision !== 'number'
  ) {
    return { ok: false, reason: 'missing-dirty-state' }
  }
  const cancelToken = options.cancelToken
  if (!cancelToken) return { ok: false, reason: 'missing-dirty-state' }

  const root = deps.getRoot()
  if (!root) return { ok: false, reason: 'no-workspace-root' }

  // Real (symlink-resolved) root, computed once per plan — per-file realpath checks compare
  // against it. If the root itself cannot be resolved there is nothing to compare with, and the
  // lexical containment from phase 1 remains the only guard.
  let realRoot: string | null
  try {
    realRoot = realpathSync(root)
  } catch {
    realRoot = null
  }

  const built = buildScope(options.include, options.exclude, root, deps.io)
  if (built.blocking) {
    const diagnostic: SearchDiagnostic | undefined = built.diagnostics[0]
    return { ok: false, reason: 'invalid-pattern', diagnostic }
  }

  const matchCase = options.matchCase === true
  // The match semantics travel with the plan (§13.8): regex and whole-word change what counts as a
  // hit, so a plan built without them is not the plan the user confirmed.
  const opts: MatchOptions = {
    matchCase,
    regexp: options.regexp === true,
    wholeWord: options.wholeWord === true,
  }
  const compiled = createScanner(query, opts)
  if (!compiled.ok) {
    // Same rule as search (D33): a pattern that does not compile fails the whole plan, and writes
    // nothing. Silently treating it as literal would replace different text than the user saw.
    return {
      ok: false,
      reason: 'invalid-regex',
      diagnostic: {
        code: 'invalid-regex',
        field: 'query',
        blocking: true,
        message: compiled.message,
      },
    }
  }
  const factory = compiled.factory
  const unsaved = new Set(options.unsavedDocumentIds)
  const target = options.target
  const targetId = target ? target.documentId : null

  const { candidates, skipped } = collectCandidates(
    deps.getDocuments(),
    root,
    built.scope,
    unsaved,
    targetId,
  )

  // Bound how many files we will even look at: phase-2 work must not run unbounded.
  if (candidates.length > MAX_REPLACE_FILES) {
    return abort(
      'files',
      candidates.slice(MAX_REPLACE_FILES).map((c) => c.rel),
      candidates.length,
    )
  }

  const controller = new AbortController()
  running.set(cancelToken, controller)
  const files: PlanFile[] = []
  let totalInput = 0
  let totalOutput = 0
  let totalCount = 0
  let processed = 0

  try {
    for (const candidate of candidates) {
      if (controller.signal.aborted) return cancelled(files)
      await yieldToEventLoop()
      if (controller.signal.aborted) return cancelled(files)
      processed += 1
      onProgress?.(processed, candidates.length)

      const { doc, rel } = candidate
      const filePath = doc.filePath
      if (!deps.io.exists(filePath)) {
        skipped.push({ documentId: doc.id, relPath: rel, reason: 'missing-file' })
        continue
      }
      let buf: Buffer
      try {
        buf = deps.io.readFile(filePath)
      } catch {
        skipped.push({ documentId: doc.id, relPath: rel, reason: 'unreadable' })
        continue
      }

      // §5.5.3: a link inside the root may point outside it. Skipping the file keeps the write
      // inside the workspace the user confirmed, at the cost of one realpath per candidate.
      if (realRoot && escapesRootViaSymlink(filePath, realRoot)) {
        skipped.push({ documentId: doc.id, relPath: rel, reason: 'out-of-root' })
        continue
      }

      // Budget accounting happens BEFORE any write is queued, and stops the scan immediately —
      // scanning everything and only then reporting "too big" would burn the very I/O it protects.
      totalInput += buf.byteLength
      if (buf.byteLength > MAX_REPLACE_FILE_BYTES) return abort('file-bytes', [rel], 1)
      if (totalInput > MAX_REPLACE_TOTAL_INPUT_BYTES) return abort('input-bytes', [rel], 1)

      const { bom, body } = splitBom(buf)
      const encoding = doc.encoding || 'utf-8'
      const text = iconv.decode(body, encoding)

      let newText: string
      let count: number
      const at = target && 'matchStartUtf16' in target ? target.matchStartUtf16 : null
      if (at !== null) {
        // "Replace Here": exactly the occurrence the user clicked, re-verified against the CURRENT
        // bytes rather than a remembered offset. The same factory does the verification and the
        // replacement, so regex replacement expansion (`$1`) behaves as the user expects.
        const one = factory.replaceOne(text, at, replaceText)
        if (one.count === 0) {
          skipped.push({ documentId: doc.id, relPath: rel, reason: 'no-hit' })
          continue
        }
        newText = one.text
        count = 1
      } else {
        count = factory.count(text)
        if (count === 0) {
          skipped.push({ documentId: doc.id, relPath: rel, reason: 'no-hit' })
          continue
        }
        newText = factory.replace(text, replaceText).text
      }

      totalCount += count
      if (totalCount > MAX_REPLACE_COUNT) return abort('count', [rel], 1)

      const encoded = encodeLossless(newText, encoding)
      if (!encoded) {
        skipped.push({ documentId: doc.id, relPath: rel, reason: 'unreadable' })
        continue
      }
      // Output bytes are measured on the ACTUAL buffer that would be written (BOM included), not
      // approximated from string lengths: a multi-byte replacement string makes the two diverge.
      const outputBytes = bom.byteLength + encoded.byteLength
      totalOutput += outputBytes
      if (totalOutput > MAX_REPLACE_OUTPUT_BYTES) return abort('output-bytes', [rel], 1)

      // The file-count cap is enforced once, above, on the candidate list — re-checking it here
      // after every file could only ever fire one file too late, so it was removed rather than
      // left as a second, differently-off-by-one guard.
      files.push({
        documentId: doc.id,
        filePath,
        relPath: rel,
        encoding,
        bom,
        baselineHash: sha256(buf),
        newText,
        matchCount: count,
        outputBytes,
      })
    }
  } finally {
    running.delete(cancelToken)
  }

  const summary: ReplacePlanSummary = {
    planId: randomUUID(),
    fileCount: files.length,
    matchCount: files.reduce((sum, f) => sum + f.matchCount, 0),
    skipped,
  }
  plans.set(summary.planId, {
    planId: summary.planId,
    root,
    session: deps.getSession(),
    query,
    replaceText,
    include: options.include ?? '',
    exclude: options.exclude ?? '',
    matchCase,
    regexp: opts.regexp,
    wholeWord: opts.wholeWord,
    revision: options.documentStateRevision,
    unsaved: [...options.unsavedDocumentIds],
    files,
    applied: false,
  })
  return { ok: true, plan: summary }
}

function abort(
  limit: BudgetLimit,
  offending: string[],
  offendingTotal: number,
): ReplacePlanOutcome {
  return {
    ok: false,
    reason: 'aborted',
    aborted: { reason: 'aborted', limit, offending, offendingTotal },
  }
}

function cancelled(files: PlanFile[]): ReplacePlanOutcome {
  // Partial results are NOT kept: a half-scanned plan could never be honestly presented as
  // "N hits in M files", and applying it would be applying something the user never confirmed.
  return {
    ok: false,
    reason: 'cancelled',
    aborted: {
      reason: 'cancelled',
      limit: 'files',
      offending: files.map((f) => f.relPath),
      offendingTotal: files.length,
    },
  }
}

// ─── cancel ────────────────────────────────────────────────────────────────────────────────────

/** Stop a running plan. Returns false when the token is unknown (already finished). */
export function cancelReplace(cancelToken: string): boolean {
  const controller = running.get(cancelToken)
  if (!controller) return false
  controller.abort()
  return true
}

// ─── apply ─────────────────────────────────────────────────────────────────────────────────────

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

export async function applyReplace(
  options: ReplaceApplyOptions,
  deps: ReplaceDeps,
): Promise<ReplaceApplyOutcome> {
  const plan = plans.get(options?.planId ?? '')
  if (!plan || plan.applied) {
    return { ok: false, reason: 'stale-plan', files: [] }
  }
  // The plan is bound to the workspace it was computed in (ADR-0023).
  if (plan.root !== deps.getRoot() || plan.session !== deps.getSession()) {
    return { ok: false, reason: 'workspace-changed', files: [] }
  }
  // Re-take the dirty state and require it to match: a buffer that became dirty between "plan"
  // and "apply" would be overwritten by disk bytes, silently destroying the user's edit (D28).
  if (
    typeof options.documentStateRevision !== 'number' ||
    options.documentStateRevision !== plan.revision ||
    !Array.isArray(options.unsavedDocumentIds) ||
    !sameStringSet(options.unsavedDocumentIds, plan.unsaved)
  ) {
    return { ok: false, reason: 'revision-mismatch', files: [] }
  }

  plan.applied = true
  const outcomes: ReplaceFileOutcome[] = []
  const before: UndoEntry[] = []
  let replaced = 0

  for (const file of plan.files) {
    // Unreachable by construction: `plan.files` is built by skipping every unsaved document, and
    // the gate below already refuses an apply whose unsaved set differs from the plan's. Kept as
    // an independent last line of defence on the write path, and excluded from coverage because no
    // input can reach it (same treatment as `ui.ts`'s `import.meta.env.DEV` branch).
    /* v8 ignore next 9 */
    if (options.unsavedDocumentIds.includes(file.documentId)) {
      outcomes.push({
        documentId: file.documentId,
        relPath: file.relPath,
        status: 'skipped',
        replaced: 0,
        reason: 'unsaved',
      })
      continue
    }
    let current: Buffer
    try {
      current = deps.io.readFile(file.filePath)
    } catch {
      outcomes.push({
        documentId: file.documentId,
        relPath: file.relPath,
        status: 'failed',
        replaced: 0,
        reason: 'write-error',
      })
      continue
    }
    // Re-check immediately before committing. This narrows — but does NOT eliminate — the TOCTOU
    // window in which another process could rewrite the file; requires that we say so
    // rather than claim the hash check is absolute.
    if (sha256(current) !== file.baselineHash) {
      outcomes.push({
        documentId: file.documentId,
        relPath: file.relPath,
        status: 'conflict',
        replaced: 0,
        reason: 'external-change',
      })
      continue
    }
    const encoded = encodeLossless(file.newText, file.encoding)
    // Unreachable by construction: the same (frozen `newText`, `encoding`) pair already passed
    // `encodeLossless` at plan time, so recomputing it cannot produce null. Kept so a future
    // change to the plan/apply split cannot silently write mojibake.
    /* v8 ignore next 9 */
    if (!encoded) {
      outcomes.push({
        documentId: file.documentId,
        relPath: file.relPath,
        status: 'failed',
        replaced: 0,
        reason: 'unencodable',
      })
      continue
    }
    const out = Buffer.concat([file.bom, encoded])
    try {
      deps.io.writeFileAtomic(file.filePath, out)
    } catch {
      outcomes.push({
        documentId: file.documentId,
        relPath: file.relPath,
        status: 'failed',
        replaced: 0,
        reason: 'write-error',
      })
      continue
    }
    // Without this the watcher reports our own write as an external change and the app prompts to
    // reload the file it just rewrote.
    deps.markOwnWrite(file.filePath)
    deps.applyToStore(file.documentId, file.newText)
    before.push({
      filePath: file.filePath,
      documentId: file.documentId,
      encoding: file.encoding,
      bom: file.bom,
      before: current,
      afterHash: sha256(out),
    })
    replaced += file.matchCount
    outcomes.push({
      documentId: file.documentId,
      relPath: file.relPath,
      status: 'ok',
      replaced: file.matchCount,
    })
    await yieldToEventLoop()
  }

  if (before.length > 0) {
    lastTransaction = { root: plan.root, session: plan.session, files: before }
  }
  plans.delete(plan.planId)
  return { ok: true, replaced, files: outcomes }
}

// ─── undo ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Restore the most recent replace transaction. Session-only by design (ADR-0023): one slot,
 * replaced by the next successful replace, never promised to survive quitting.
 */
export async function undoLastReplace(deps: ReplaceDeps): Promise<ReplaceUndoOutcome> {
  if (!lastTransaction) return { ok: false, restored: 0, skipped: 0, reason: 'no-transaction' }
  if (lastTransaction.root !== deps.getRoot() || lastTransaction.session !== deps.getSession()) {
    return { ok: false, restored: 0, skipped: 0, reason: 'workspace-changed' }
  }
  let restored = 0
  let skipped = 0
  for (const entry of lastTransaction.files) {
    let current: Buffer
    try {
      current = deps.io.readFile(entry.filePath)
    } catch {
      skipped += 1
      continue
    }
    // Only restore what is still exactly what we wrote: anything else means the user (or another
    // program) edited it afterwards, and overwriting that would lose their work.
    if (sha256(current) !== entry.afterHash) {
      skipped += 1
      continue
    }
    try {
      deps.io.writeFileAtomic(entry.filePath, entry.before)
      deps.markOwnWrite(entry.filePath)
      deps.applyToStore(entry.documentId, iconv.decode(splitBom(entry.before).body, entry.encoding))
      restored += 1
    } catch {
      skipped += 1
    }
    await yieldToEventLoop()
  }
  lastTransaction = null
  return { ok: true, restored, skipped }
}

/** Test seam: drop every plan, running task and undo record. Production never calls this. */
export function __resetReplaceForTests(): void {
  plans.clear()
  running.clear()
  lastTransaction = null
}
