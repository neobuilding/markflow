import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokes: Array<{ channel: string; args: unknown[] }> = []
const subs: Array<{ channel: string; cb: (payload: unknown) => void }> = []
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args })
      return Promise.resolve()
    },
    on: (channel: string, cb: (payload: unknown) => void) => subs.push({ channel, cb }),
  },
}))
// `onReplaceProgress` subscribes through `_shared.onIpc`; mock it so the subscription is observable
// without Electron.
vi.mock('./_shared', () => ({
  onIpc: (channel: string, cb: (payload: unknown) => void) => {
    subs.push({ channel, cb })
    return () => {}
  },
}))

import { replaceApi, onReplaceProgress } from './replace'
import type { ReplacePlanOptions, ReplaceApplyOptions } from '../../../shared/searchTypes'

const planOptions: ReplacePlanOptions = {
  query: 'cat',
  replaceText: 'dog',
  include: '',
  exclude: '',
  unsavedDocumentIds: [],
  documentStateRevision: 1,
  cancelToken: 'tok-plan',
}

const applyOptions: ReplaceApplyOptions = {
  planId: 'P1',
  unsavedDocumentIds: [],
  documentStateRevision: 1,
}

beforeEach(() => {
  invokes.length = 0
  subs.length = 0
})

describe('preload replaceApi', () => {
  it('plan forwards the frozen options verbatim to search:replace:plan', () => {
    replaceApi.plan(planOptions)
    expect(invokes[0]).toEqual({ channel: 'search:replace:plan', args: [planOptions] })
  })

  it('apply forwards its options to search:replace:apply', () => {
    replaceApi.apply(applyOptions)
    expect(invokes[0]).toEqual({ channel: 'search:replace:apply', args: [applyOptions] })
  })

  it('cancel forwards the token as a single-field payload', () => {
    replaceApi.cancel('tok-9')
    expect(invokes[0]).toEqual({
      channel: 'search:replace:cancel',
      args: [{ cancelToken: 'tok-9' }],
    })
  })

  it('undo forwards to search:replace:undo with no arguments', () => {
    replaceApi.undo()
    expect(invokes[0]).toEqual({ channel: 'search:replace:undo', args: [] })
  })
})

describe('preload onReplaceProgress', () => {
  it('subscribes to search:replace:progress and returns an unsubscribe', () => {
    const cb = vi.fn()
    const off = onReplaceProgress(cb)
    expect(subs[0].channel).toBe('search:replace:progress')
    expect(typeof subs[0].cb).toBe('function')
    // The wrapper forwards the payload to the caller's callback.
    subs[0].cb({ cancelToken: 't', done: 1, total: 2 })
    expect(cb).toHaveBeenCalledWith({ cancelToken: 't', done: 1, total: 2 })
    expect(typeof off).toBe('function')
  })
})
