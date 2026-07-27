import { join } from 'path'
import { mkdirSync, existsSync, unlinkSync } from 'fs'
import type { App } from 'electron'
import type Database from 'better-sqlite3'

// Use dynamic require wrapped in a function so Rollup won't hoist it to top level.
// better-sqlite3 depends on 'bindings' which is bundled in the asar.
function loadBetterSqlite3(): typeof import('better-sqlite3') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('better-sqlite3')
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function initDatabase(app: App): void {
  const userDataPath = app.getPath('userData')
  const dbDir = join(userDataPath, 'data')
  mkdirSync(dbDir, { recursive: true })

  const dbPath = join(dbDir, 'markflow.db')

  // Backward-compat: the database used to live under AppData\Roaming\markflow\data and
  // may still contain document content. Even though userData is now redirected to a temp
  // directory, clean up that legacy location to avoid leaking content.
  try {
    const legacyDir = join(app.getPath('appData'), 'markflow', 'data')
    for (const f of ['markflow.db', 'markflow.db-wal', 'markflow.db-shm']) {
      const p = join(legacyDir, f)
      if (existsSync(p)) unlinkSync(p)
    }
  } catch {
    // Ignore cleanup failures
  }

  // Privacy: document content (and the full-text index) must not persist to disk, so
  // that deleting the .md file doesn't leave content behind in the database and leak it
  // unintentionally. We therefore use an in-memory database — once the process exits,
  // everything (content / metadata / search index) is gone from disk.
  // We also delete any old on-disk database files to clear content that may remain there.
  try {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(f)) unlinkSync(f)
    }
  } catch {
    // Cleanup failure must not block startup
  }

  // Require better-sqlite3 at runtime inside a try/catch to show a friendly error
  // instead of crashing the entire process.
  let DatabaseConstructor: any
  try {
    DatabaseConstructor = loadBetterSqlite3()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to load better-sqlite3: ${msg}`)
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
