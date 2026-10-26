// @vitest-environment node
// Exercises the IPC plumbing only — every decision lives in service/replace.ts (covered there).
// Here we assert the handlers are wired, delegate to the service, push progress over the real
// channel, and the sender-destroyed guard is honoured (ADR-0023: plan is async + cancellable, so
// progress is pushed, not returned).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkTestDir } from '../test-support/tmp'
import { createMemoryDiskIO, type MemoryDiskIO } from '../lib/disk-io'
import { registerReplaceHandlers, REPLACE_PROGRESS_CHANNEL } from './replace'
import type { IpcMain } from 'electron'
import type { Document } from '../model/documentStore'

const ROOT_DIR = mkTestDir('mf-replace-ipc-')

// Closed-over in-memory store so the handlers run against a Map instead of the real singleton.
const docMap = new Map<string, Document>()
vi.mock('../model/documentStore', () => ({
  getAllDocuments: () => [...docMap.values()],
  getDocumentById: (id: string) => docMap.get(id) ?? null,
  getDocumentByFilePath: (filePath: string) => {
    for (const d of docMap.values()) if (d.filePath === filePath) return d
    return null
  },
  upsertDocument: (doc: Document) => {
    docMap.set(doc.id, { ...doc })
    return docMap.get(doc.id)!
  },
  updateDocument: (id: string, partial: Partial<Document>) => {
    const d = docMap.get(id)
    if (!d) return null
    const next = { ...d, ...partial, id }
    docMap.set(id, next)
    return next
  },
  createDocumentStore: () => docMap.clear(),
}))
vi.mock('../model/workspaceRoot', () => ({
  getWorkspaceRoot: () => ROOT_DIR,
  getWorkspaceSession: () => 'session-1',
  setWorkspaceRoot: vi.fn(),
}))
vi.mock('../model/folderWatcher', () => ({ markOwnWrite: vi.fn() }))

import { upsertDocument, getAllDocuments } from '../model/documentStore'

const TOKEN = 'cancel-token-1'

function makeIpc(isDestroyed = false) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  } as unknown as IpcMain
  const send = vi.fn()
  const event = { sender: { isDestroyed: () => isDestroyed, send } }
  async function call(channel: string, ...args: unknown[]) {
    return handlers.get(channel)!(event, ...args)
  }
  return { ipcMain, send, call }
}

const io: MemoryDiskIO = createMemoryDiskIO()
let ipc: ReturnType<typeof makeIpc>

function seed(content: string, id = 'd1', title = 'A') {
  const filePath = join(ROOT_DIR, `${id}.md`)
  io.writeFile(filePath, Buffer.from(content))
  upsertDocument({
    id,
    title,
    filePath,
    folderPath: ROOT_DIR,
    content,
    wordCount: 0,
    encoding: 'utf-8',
    encodingConfidence: 1,
    createdAt: 0,
    updatedAt: 0,
  })
}

function planOptions(overrides: Record<string, unknown> = {}) {
  return {
    query: 'cat',
    replaceText: 'dog',
    include: '',
    exclude: '',
    unsavedDocumentIds: [] as string[],
    documentStateRevision: 0,
    cancelToken: TOKEN,
    ...overrides,
  }
}

beforeEach(() => {
  docMap.clear()
  ipc = makeIpc()
  registerReplaceHandlers(ipc.ipcMain, io)
})

describe('replace IPC handlers (ADR-0023)', () => {
  it('plan delegates to the service and pushes progress over the channel', async () => {
    seed('the cat sat')
    const res = (await ipc.call('search:replace:plan', planOptions())) as {
      ok: boolean
      plan: { planId: string; fileCount: number; matchCount: number }
    }

    expect(res.ok).toBe(true)
    expect(res.plan.fileCount).toBe(1)
    expect(res.plan.matchCount).toBe(1)
    expect(res.plan.planId).toBeTruthy()
    expect(ipc.send).toHaveBeenCalledWith(REPLACE_PROGRESS_CHANNEL, {
      cancelToken: TOKEN,
      done: 1,
      total: 1,
    })
  })

  it('applies the plan, writes the file, then undo restores it', async () => {
    seed('the cat sat')
    const plan = (await ipc.call('search:replace:plan', planOptions())) as {
      ok: boolean
      plan: { planId: string }
    }

    const applied = (await ipc.call('search:replace:apply', {
      planId: plan.plan.planId,
      unsavedDocumentIds: [],
      documentStateRevision: 0,
    })) as { ok: boolean; replaced: number; files: unknown[] }
    expect(applied.ok).toBe(true)
    expect(applied.replaced).toBe(1)
    expect(applied.files).toHaveLength(1)
    expect(getAllDocuments().find((d) => d.id === 'd1')?.content).toBe('the dog sat')

    const undone = (await ipc.call('search:replace:undo')) as { ok: boolean; restored: number }
    expect(undone.ok).toBe(true)
    expect(undone.restored).toBe(1)
    expect(getAllDocuments().find((d) => d.id === 'd1')?.content).toBe('the cat sat')
  })

  it('returns missing-dirty-state when the binding fields are absent', async () => {
    seed('the cat sat')
    // Omit cancelToken (and the binding is required) — the service must refuse rather than plan.
    const res = (await ipc.call('search:replace:plan', {
      query: 'cat',
      replaceText: 'dog',
      include: '',
      exclude: '',
      unsavedDocumentIds: [],
      documentStateRevision: 0,
    })) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing-dirty-state')
  })

  it('cancel returns false for an unknown token and for a missing token', async () => {
    // Unknown token: the running map has nothing for it.
    expect(await ipc.call('search:replace:cancel', { cancelToken: 'never-issued' })).toBe(false)
    // `?? ''` fallback when no token is supplied.
    expect(await ipc.call('search:replace:cancel', {})).toBe(false)
  })

  it('does not push progress when the sender is already destroyed', async () => {
    ipc = makeIpc(true)
    registerReplaceHandlers(ipc.ipcMain, io)
    seed('the cat sat')
    const res = (await ipc.call('search:replace:plan', planOptions())) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(ipc.send).not.toHaveBeenCalled()
  })
})
