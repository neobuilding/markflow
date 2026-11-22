import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideExternalFile, maybeDecideExternalPaths } from './workspaceExternalDecision'
import { navigateToPath } from './documentNavigation'
import { switchWorkspace } from './workspaceSwitch'
import { useUIStore } from '../store/ui'
import type { WorkspaceExternalChoice } from '../../../../shared/linkTypes'

vi.mock('./documentNavigation', () => ({
  navigateToPath: vi.fn(async () => true),
}))

vi.mock('./workspaceSwitch', () => ({
  switchWorkspace: vi.fn(async () => true),
}))

const api = {
  dialog: {
    confirmWorkspaceExternal: vi.fn(
      async (_path: string): Promise<WorkspaceExternalChoice> => 'cancel',
    ),
  },
  app: {
    openInNewWindow: vi.fn(async (_path: string) => true),
  },
  documents: {
    getWorkspaceRoot: vi.fn(async () => 'C:/notes' as string | null),
  },
}

describe('workspaceExternalDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = api
    useUIStore.setState({ workspaceRoot: null })
    api.dialog.confirmWorkspaceExternal.mockResolvedValue('cancel')
    api.documents.getWorkspaceRoot.mockResolvedValue('C:/notes')
  })

  it('opens a new window for the new-window choice', async () => {
    api.dialog.confirmWorkspaceExternal.mockResolvedValue('new-window')
    await expect(decideExternalFile('D:/other/a.md')).resolves.toBe('new-window')
    expect(api.app.openInNewWindow).toHaveBeenCalledWith('D:/other/a.md')
    expect(navigateToPath).not.toHaveBeenCalled()
    expect(switchWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the workspace for the keep-workspace choice', async () => {
    api.dialog.confirmWorkspaceExternal.mockResolvedValue('keep-workspace')
    await expect(decideExternalFile('D:/other/a.md')).resolves.toBe('keep-workspace')
    expect(navigateToPath).toHaveBeenCalledWith('D:/other/a.md', { openMode: 'external-keep' })
    expect(api.app.openInNewWindow).not.toHaveBeenCalled()
  })

  it('switches workspace AND opens the picked file for the switch-workspace choice', async () => {
    api.dialog.confirmWorkspaceExternal.mockResolvedValue('switch-workspace')
    await expect(decideExternalFile('D:/other/a.md')).resolves.toBe('switch-workspace')
    // `openPath` is what makes the chosen file the active document: without it the swap would
    // keep the PREVIOUS document and never open what the user picked.
    expect(switchWorkspace).toHaveBeenCalledWith('D:/other', {
      openMode: 'external-switch',
      openPath: 'D:/other/a.md',
      title: 'a.md',
    })
  })

  it('does nothing for cancel', async () => {
    await expect(decideExternalFile('D:/other/a.md')).resolves.toBe('cancel')
    expect(api.app.openInNewWindow).not.toHaveBeenCalled()
    expect(navigateToPath).not.toHaveBeenCalled()
    expect(switchWorkspace).not.toHaveBeenCalled()
  })

  it('intercepts a single outside Markdown file', async () => {
    api.dialog.confirmWorkspaceExternal.mockResolvedValue('new-window')
    await expect(maybeDecideExternalPaths(['D:/other/a.md'])).resolves.toBe(true)
    expect(api.dialog.confirmWorkspaceExternal).toHaveBeenCalledWith('D:/other/a.md')
    expect(api.app.openInNewWindow).toHaveBeenCalledWith('D:/other/a.md')
  })

  it('leaves workspace-internal files to the caller', async () => {
    await expect(maybeDecideExternalPaths(['C:/notes/a.md'])).resolves.toBe(false)
    expect(api.dialog.confirmWorkspaceExternal).not.toHaveBeenCalled()
  })

  it('leaves non-Markdown files to the caller', async () => {
    await expect(maybeDecideExternalPaths(['D:/other/a.pdf'])).resolves.toBe(false)
  })

  it('leaves multi-file and folder batches to the caller', async () => {
    await expect(maybeDecideExternalPaths(['D:/other/a.md', 'D:/other/b.md'])).resolves.toBe(false)
    expect(api.dialog.confirmWorkspaceExternal).not.toHaveBeenCalled()
  })

  it('reads the root from main when the store has no mirror', async () => {
    useUIStore.setState({ workspaceRoot: null })
    api.dialog.confirmWorkspaceExternal.mockResolvedValue('cancel')
    await expect(maybeDecideExternalPaths(['C:/notes/a.md'])).resolves.toBe(false)
    expect(api.documents.getWorkspaceRoot).toHaveBeenCalled()
  })
})
