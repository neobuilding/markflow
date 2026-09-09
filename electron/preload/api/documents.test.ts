import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture every ipcRenderer.invoke call the documents bridge issues.
const invokes: Array<{ channel: string; args: unknown[] }> = []
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args })
      return Promise.resolve({ ok: true })
    },
  },
}))

import { documentsApi } from './documents'

beforeEach(() => {
  invokes.length = 0
})

describe('preload documentsApi', () => {
  it('list invokes documents:list with the folder path', () => {
    documentsApi.list('MyFolder')
    expect(invokes[0]).toEqual({ channel: 'documents:list', args: ['MyFolder'] })
  })

  it('get invokes documents:get with the id', () => {
    documentsApi.get('d1')
    expect(invokes[0]).toEqual({ channel: 'documents:get', args: ['d1'] })
  })

  it('create invokes documents:create with the params object', () => {
    const params = { title: 'T', content: 'C', memoryOnly: true }
    documentsApi.create(params)
    expect(invokes[0]).toEqual({ channel: 'documents:create', args: [params] })
  })

  it('update invokes documents:update with id + updates', () => {
    documentsApi.update('d1', { title: 'X' })
    expect(invokes[0]).toEqual({ channel: 'documents:update', args: ['d1', { title: 'X' }] })
  })

  it('delete invokes documents:delete with the id', () => {
    documentsApi.delete('d1')
    expect(invokes[0]).toEqual({ channel: 'documents:delete', args: ['d1'] })
  })

  it('import invokes documents:import with the file path', () => {
    documentsApi.import('/a.md')
    expect(invokes[0]).toEqual({ channel: 'documents:import', args: ['/a.md'] })
  })

  it('importMany invokes documents:import-many with the path array', () => {
    documentsApi.importMany(['/a.md', '/b.md'])
    expect(invokes[0]).toEqual({ channel: 'documents:import-many', args: [['/a.md', '/b.md']] })
  })

  it('saveAs invokes documents:save-as with id, path, params', () => {
    documentsApi.saveAs('d1', '/o.md', { title: 'T' })
    expect(invokes[0]).toEqual({
      channel: 'documents:save-as',
      args: ['d1', '/o.md', { title: 'T' }],
    })
  })

  it('reload invokes documents:reload with the id', () => {
    documentsApi.reload('d1')
    expect(invokes[0]).toEqual({ channel: 'documents:reload', args: ['d1'] })
  })

  it('setEncoding invokes documents:set-encoding with id + encoding', () => {
    documentsApi.setEncoding('d1', 'utf-8')
    expect(invokes[0]).toEqual({ channel: 'documents:set-encoding', args: ['d1', 'utf-8'] })
  })

  it('stat invokes documents:stat with the path', () => {
    documentsApi.stat('/a.md')
    expect(invokes[0]).toEqual({ channel: 'documents:stat', args: ['/a.md'] })
  })

  it('eol invokes documents:eol with the path', () => {
    documentsApi.eol('/a.md')
    expect(invokes[0]).toEqual({ channel: 'documents:eol', args: ['/a.md'] })
  })

  it('resolveAppdoc invokes documents:resolve-appdoc with the url', () => {
    documentsApi.resolveAppdoc('appdoc://d1/im.png')
    expect(invokes[0]).toEqual({
      channel: 'documents:resolve-appdoc',
      args: ['appdoc://d1/im.png'],
    })
  })

  it('setEol invokes documents:set-eol with the path and eol', () => {
    documentsApi.setEol('/a.md', '\r\n')
    expect(invokes[0]).toEqual({ channel: 'documents:set-eol', args: ['/a.md', '\r\n'] })
  })

  it('detectEncoding invokes documents:detect-encoding with the path', () => {
    documentsApi.detectEncoding('/a.md')
    expect(invokes[0]).toEqual({ channel: 'documents:detect-encoding', args: ['/a.md'] })
  })

  it('createFolder invokes documents:create-folder with the path', () => {
    documentsApi.createFolder('/notes/new')
    expect(invokes[0]).toEqual({ channel: 'documents:create-folder', args: ['/notes/new'] })
  })

  it('renameFolder invokes documents:rename-folder with old and new paths', () => {
    documentsApi.renameFolder('/a', '/b')
    expect(invokes[0]).toEqual({ channel: 'documents:rename-folder', args: ['/a', '/b'] })
  })
  it('renameFile invokes documents:rename-file with old and new paths', () => {
    documentsApi.renameFile('/a.md', '/b.md')
    expect(invokes[0]).toEqual({ channel: 'documents:rename-file', args: ['/a.md', '/b.md'] })
  })

  it('deleteFolder invokes documents:delete-folder with the path', () => {
    documentsApi.deleteFolder('/notes/old')
    expect(invokes[0]).toEqual({ channel: 'documents:delete-folder', args: ['/notes/old'] })
  })

  it('listFolders invokes documents:list-folders with the path', () => {
    documentsApi.listFolders('/notes')
    expect(invokes[0]).toEqual({ channel: 'documents:list-folders', args: ['/notes'] })
  })

  it('setOpenFolder invokes documents:set-open-folder with the folder path', () => {
    documentsApi.setOpenFolder('/notes')
    expect(invokes[0]).toEqual({ channel: 'documents:set-open-folder', args: ['/notes'] })
  })

  it('clearOpenFolders invokes documents:clear-open-folders with no arguments', () => {
    documentsApi.clearOpenFolders()
    expect(invokes[0]).toEqual({ channel: 'documents:clear-open-folders', args: [] })
  })

  it('undoRename invokes documents:undo-rename with no arguments', () => {
    documentsApi.undoRename()
    expect(invokes[0]).toEqual({ channel: 'documents:undo-rename', args: [] })
  })
})
