import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTabsDialogOptions,
  showCloseAllTabsDialog,
  showCloseTabDialog,
} from './closeTabDialog'
import { useUIStore } from '../store/ui'
import { t } from '../i18n'

describe('closeTabDialog (ADR-0040)', () => {
  beforeEach(() => {
    useUIStore.getState().setDialogOpen(false)
  })

  it('builds the aggregate options with all titles in the message', () => {
    const options = closeTabsDialogOptions(['a.md', 'b.md'], t)
    expect(options.message).toContain('a.md')
    expect(options.message).toContain('b.md')
    expect(options.okText).toBe('Discard')
    expect(options.cancelText).toBe('Keep editing')
  })

  it('falls back to the legacy workspace message when no tab titles exist', () => {
    const options = closeTabsDialogOptions([], t)
    expect(options.message).toBe('You have unsaved changes. Discard them and close the workspace?')
  })

  it('single-tab close returns the user answer and clears the dialog lock', async () => {
    const confirm = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    expect(await showCloseTabDialog('a.md', t)).toBe(true)
    expect(confirm).toHaveBeenCalledWith({
      message: expect.stringContaining('a.md'),
      okText: 'Discard',
      cancelText: 'Keep editing',
    })
    expect(useUIStore.getState().dialogOpen).toBe(false)
  })

  it('aggregate close cancels and clears the dialog lock', async () => {
    const confirm = vi.fn(async () => false)
    ;(window as unknown as { api: unknown }).api = { dialog: { confirm } }
    expect(await showCloseAllTabsDialog(['a.md'], t)).toBe(false)
    expect(useUIStore.getState().dialogOpen).toBe(false)
  })

  it('returns false without a dialog bridge (never silently discards)', async () => {
    ;(window as unknown as { api?: unknown }).api = undefined
    expect(await showCloseTabDialog('a.md', t)).toBe(false)
    expect(await showCloseAllTabsDialog(['a.md'], t)).toBe(false)
    expect(useUIStore.getState().dialogOpen).toBe(false)
  })
})
