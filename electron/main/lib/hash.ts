// Content hashing for the cross-file replace pipeline (ADR-0023).
//
// `baselineHash = sha256(buffer)` is the ONLY trustworthy "has this file changed since I read it?"
// signal available here:
//
//   * mtime is unusable in tests — `createMemoryDiskIO().stat().mtimeMs` is a constant, so a
//     "file changed" assertion could never be made green (and a green test would prove nothing).
//   * comparing against the store's `content` is useless for unsaved edits, because the store's
//     content IS the bytes last read from disk (ADR-0023).
//
// sha256 of the raw bytes is encoding-agnostic (no iconv round-trip can hide a change) and cheap
// enough at Markdown file sizes.
import { createHash } from 'node:crypto'

export function sha256(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
