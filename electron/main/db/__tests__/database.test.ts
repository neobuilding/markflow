import { describe, it, expect, vi } from 'vitest'

describe('database', () => {
  it('throws when accessed before initialization', async () => {
    vi.resetModules()
    const mod = await import('../database')
    expect(() => mod.getDb()).toThrow(/not initialized/i)
  })

  it('initializes an in-memory database and exposes it via getDb', async () => {
    vi.resetModules()
    const mod = await import('../database')
    await mod.initDatabase()
    const db = mod.getDb()
    expect(db).toBeTruthy()
    // the re-exported `db` binding points at the same instance
    expect(mod.db).toBe(db)
  })

  it('creates the schema and round-trips a document row', async () => {
    vi.resetModules()
    const mod = await import('../database')
    await mod.initDatabase()
    const db = mod.getDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO documents (id, title, file_path, content, word_count, encoding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('doc-1', 'Hello', '/tmp/hello.md', '# Hello', 1, 'utf-8', now, now)

    const row = db
      .prepare('SELECT id, title, file_path FROM documents WHERE id = ?')
      .get('doc-1') as { id: string; title: string; file_path: string }
    expect(row).toMatchObject({ id: 'doc-1', title: 'Hello', file_path: '/tmp/hello.md' })
  })

  it('enforces the unique file_path constraint', async () => {
    vi.resetModules()
    const mod = await import('../database')
    await mod.initDatabase()
    const db = mod.getDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO documents (id, title, file_path, content, word_count, encoding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a', 'A', '/dup.md', '', 0, 'utf-8', now, now)
    expect(() =>
      db
        .prepare(
          `INSERT INTO documents (id, title, file_path, content, word_count, encoding, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('b', 'B', '/dup.md', '', 0, 'utf-8', now, now),
    ).toThrow()
  })
})
