// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ADR-0040 §8.1: every tabs:* channel must be registered through scopedHandleFor;
// a bare ipcMain.handle on a tabs channel would resolve the wrong window context.

const root = join(process.cwd(), 'electron', 'main')

describe('tabs IPC scoping guard (ADR-0040)', () => {
  const files = readdirSync(join(root, 'ipc'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(root, 'ipc', name))

  it('finds the tabs handler module', () => {
    expect(files.some((file) => file.endsWith(join('ipc', 'tabs.ts')))).toBe(true)
  })

  it('registers all tabs channels via scopedHandleFor, never bare ipcMain.handle', () => {
    const source = readFileSync(join(root, 'ipc', 'tabs.ts'), 'utf8')
    const channels = [
      'tabs:begin-drag',
      'tabs:drop',
      'tabs:detach',
      'tabs:cancel-drag',
      'tabs:take-handoff',
      'tabs:accept-ack',
      'tabs:move-to-window',
      'tabs:list-windows',
    ]
    for (const channel of channels) {
      expect(source, `${channel} must be registered`).toContain(`'${channel}'`)
    }
    expect(source).toContain('scopedHandleFor')
    expect(source).not.toMatch(/ipcMain\.handle\s*\(\s*['"]tabs:/)
  })
})
