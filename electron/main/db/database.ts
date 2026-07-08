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

  // 兼容旧版：数据库原本写在 AppData\Roaming\markflow\data 下，可能残留文档内容。
  // 即便现在 userData 已重定向到临时目录，也要清理该旧位置，避免内容泄漏。
  try {
    const legacyDir = join(app.getPath('appData'), 'markflow', 'data')
    for (const f of ['markflow.db', 'markflow.db-wal', 'markflow.db-shm']) {
      const p = join(legacyDir, f)
      if (existsSync(p)) unlinkSync(p)
    }
  } catch {
    // 忽略清理失败
  }

  // 隐私：文档内容（以及全文索引）不应持久化到磁盘，避免删除 .md 文件后
  // 内容仍残留在数据库中造成无意泄露。因此使用内存数据库——进程退出后
  // 一切（内容 / 元数据 / 搜索索引）都不会留在磁盘上。
  // 同时删除旧的磁盘数据库文件，清除其中可能残留的文档内容。
  try {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(f)) unlinkSync(f)
    }
  } catch {
    // 清理失败不影响启动
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
  // better-sqlite3 在运行时动态加载，构造出的实例类型为 any；
  // 用局部常量收敛为 Database.Database，避免后续 db 可能为 null 的类型错误。
  const conn = new DatabaseConstructor(':memory:') as Database.Database

  // 内存库无需 WAL；仅启用外键约束
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
      is_starred  INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_path);
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_starred ON documents(is_starred);

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
