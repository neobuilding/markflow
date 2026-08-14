import type Database from 'better-sqlite3'

// Load better-sqlite3 via an ESM dynamic import wrapped in an async function.
//
// Why dynamic (instead of a top-level static import)?
//   1. Native module: better-sqlite3 ships a platform-specific `.node` binary. The main
//      process build uses `notBundle()`, which keeps it as an external require (never
//      inlined by Rollup), and electron-builder `asarUnpack`s it to a real on-disk path —
//      so a runtime import resolves the native binding correctly.
//   2. Graceful failure: loading is wrapped in try/catch so a missing/broken native
//      binding surfaces a friendly error instead of crashing the whole process at import.
//   3. Testability: unlike `require()`, a dynamic `import()` IS interceptable by
//      `vi.mock('better-sqlite3')`, so the failure path above can be unit-tested.
async function loadBetterSqlite3(): Promise<any> {
  return import('better-sqlite3')
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export async function initDatabase(): Promise<void> {
  // Privacy by design: the database is intentionally in-memory (':memory:'), so no
  // document content, metadata, or search index is ever written to disk. Once the
  // process exits, everything is gone — there is nothing to persist or clean up.

  // Import better-sqlite3 at runtime inside a try/catch to show a friendly error
  // instead of crashing the entire process.
  let DatabaseConstructor: any
  try {
    const mod = await loadBetterSqlite3()
    DatabaseConstructor = mod.default
  } catch (err) {
    // The `String(err)` arm (non-Error rejection) is unreachable in unit tests: Vitest
    // always wraps a throwing `vi.mock` factory into an Error, so a dynamic import can
    // never reject with a non-Error value under test. Tell v8 to ignore this branch so
    // the coverage gate reflects only what is actually exercisable.
    /* v8 ignore next */
    const msg = err instanceof Error ? err.message : String(err)
    // Attached via Object.assign so the original error is preserved as `cause` (satisfies the
    // `preserve-caught-error` rule at runtime) while still type-checking under TypeScript 7, whose
    // bundled `Error` type no longer accepts the `options` overload.
    throw Object.assign(new Error(`Failed to load better-sqlite3: ${msg}`), { cause: err })
  }
  // better-sqlite3 is loaded dynamically at runtime, so the constructed instance is typed
  // any; narrowing it to a local const of type Database.Database avoids later null-type
  // errors on db.
  const conn = new DatabaseConstructor(':memory:') as Database.Database

  // In-memory DB needs no WAL; only enable foreign-key constraints
  conn.pragma('foreign_keys = ON')

  // Run migrations
  migrate(conn)

  db = conn
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'Untitled',
      folder_path TEXT NOT NULL DEFAULT '',
      file_path   TEXT NOT NULL UNIQUE,
      content     TEXT NOT NULL DEFAULT '',
      word_count  INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      encoding    TEXT NOT NULL DEFAULT 'utf-8',
      encoding_confidence REAL NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_path);
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      id UNINDEXED,
      title,
      content,
      content=documents,
      content_rowid=rowid,
      tokenize='unicode61 tokenchars ''-_'''
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, id, title, content)
      VALUES (new.rowid, new.id, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, id, title, content)
      VALUES ('delete', old.rowid, old.id, old.title, old.content);
      INSERT INTO documents_fts(rowid, id, title, content)
      VALUES (new.rowid, new.id, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, id, title, content)
      VALUES ('delete', old.rowid, old.id, old.title, old.content);
    END;

    CREATE TABLE IF NOT EXISTS folders (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL UNIQUE,
      parent_path TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

export { db }
export type { Database }
