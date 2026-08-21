// TemplateSource service: read a PR template file into a string.
//
// This is the I/O boundary for "how do we get the template text?". The default
// implementation reads from the filesystem, but the interface (a single `read`
// function) lets tests inject an in-memory template without touching disk.
//
// Interface contract:
//   { read(path: string): string }
// `read` should throw when the file is missing/unreadable, so the caller can
// decide whether to fall back (e.g. to a commits-only body). Returning an empty
// string would be ambiguous with a legitimately empty template.
import { readFileSync } from 'node:fs'

// Default TemplateSource backed by the real filesystem.
export function createFsTemplateSource() {
  return {
    read(path) {
      return readFileSync(path, 'utf8')
    },
  }
}
