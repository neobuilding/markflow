// Unit tests for the serial-mode state reset. `waitForAppReady` is mocked because it
// drives a real Playwright page; what this suite proves is the ORDER of the reset and
// WHICH state the helper clears (docs/agents/testing.md, "Reducing e2e cost without
// losing coverage"). The real page/main-process integration stays in the e2e specs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VIEWPORTS } from './viewports'
import { waitForAppReady } from './launch'
import { resetAppState } from './reset'

vi.mock('./launch', () => ({ waitForAppReady: vi.fn(async () => {}) }))

type DocumentsApi = {
  list: () => Promise<{ id: string }[]>
  delete: (id: string) => Promise<void>
  setWorkspaceRoot: (root: null) => Promise<void>
}
type ApiWindow = { api?: { documents: DocumentsApi } }
type ConfirmGlobals = {
  __mf_confirm_calls?: unknown[]
  __confirmCalls?: unknown[]
  __nativeShowMessageBox?: unknown
  __confirmResponse?: number
}

const g = globalThis as unknown as ConfirmGlobals
const win = globalThis as unknown as ApiWindow
const ready = vi.mocked(waitForAppReady)

function fakeHandle() {
  const order: string[] = []
  let viewport: unknown
  const dialog = { showMessageBox: 'original' as unknown }
  const documents: DocumentsApi = {
    list: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]),
    delete: vi.fn(async () => {}),
    setWorkspaceRoot: vi.fn(async () => {}),
  }
  const page = {
    setViewportSize: vi.fn(async (v: unknown) => {
      viewport = v
      order.push('viewport')
    }),
    evaluate: vi.fn(async (fn: () => Promise<unknown>) => {
      order.push('documents')
      return fn()
    }),
    reload: vi.fn(async () => {
      order.push('reload')
    }),
  }
  const electronApp = {
    evaluate: vi.fn(async (fn: (electron: unknown) => void) => {
      order.push('main')
      return fn({ dialog })
    }),
  }
  const handle = { page, electronApp } as unknown as Parameters<typeof resetAppState>[0]
  return { handle, page, dialog, documents, order, getViewport: () => viewport }
}

beforeEach(() => {
  ready.mockClear()
})

afterEach(() => {
  Reflect.deleteProperty(win, 'api')
  delete g.__mf_confirm_calls
  delete g.__confirmCalls
  delete g.__nativeShowMessageBox
  delete g.__confirmResponse
})

describe('resetAppState', () => {
  it('clears renderer + main state, saves the native dialog, then reloads', async () => {
    const env = fakeHandle()
    win.api = { documents: env.documents }
    g.__mf_confirm_calls = ['stale']
    g.__confirmCalls = ['stale']
    g.__confirmResponse = 1

    await resetAppState(env.handle)

    expect(env.getViewport()).toEqual(VIEWPORTS.standard)
    expect(env.documents.list).toHaveBeenCalledTimes(1)
    expect(env.documents.delete).toHaveBeenCalledTimes(2)
    expect(env.documents.delete).toHaveBeenCalledWith('a')
    expect(env.documents.delete).toHaveBeenCalledWith('b')
    expect(env.documents.setWorkspaceRoot).toHaveBeenCalledWith(null)
    // First reset: the native handler is not recorded yet, so SAVE it.
    expect(g.__nativeShowMessageBox).toBe('original')
    expect(g.__mf_confirm_calls).toEqual([])
    expect(g.__confirmCalls).toEqual([])
    expect(g.__confirmResponse).toBeUndefined()
    expect(env.order).toEqual(['viewport', 'documents', 'main', 'reload'])
    expect(env.page.reload).toHaveBeenCalledTimes(1)
    expect(ready).toHaveBeenCalledWith(env.page)
  })

  it('restores the previously saved native dialog instead of a leftover confirm spy', async () => {
    const env = fakeHandle()
    win.api = { documents: env.documents }
    env.dialog.showMessageBox = 'spy'
    g.__nativeShowMessageBox = 'native'
    g.__mf_confirm_calls = ['stale']

    await resetAppState(env.handle)

    expect(env.dialog.showMessageBox).toBe('native')
    expect(g.__mf_confirm_calls).toEqual([])
  })
})
