// @vitest-environment node
//
// Guard test (not a helper): the dead global TitleBar component (ui/titlebar.tsx) was deleted
// with D22 — the Quick Open trigger lives in the editor's CommonToolbar instead, and reviving
// the titlebar would silently reintroduce the fourth horizontal bar this plan removed. The
// deletion is pinned here so "just reuse it" cannot happen quietly.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER_SRC = join(HERE, '..', '..')

describe('the dead TitleBar stays deleted (D22)', () => {
  it('ui/titlebar.tsx and its test do not exist', () => {
    expect(existsSync(join(HERE, 'titlebar.tsx'))).toBe(false)
    expect(existsSync(join(HERE, 'titlebar.test.tsx'))).toBe(false)
  })

  it('no renderer source imports or renders TitleBar', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(full)) {
          const text = readFileSync(full, 'utf-8')
          // CSS drag-region helpers (.titlebar-drag / --titlebar-height) on the existing
          // headers are NOT the component; only an import or a JSX tag would be.
          if (/from\s+['"][^'"]*titlebar['"]/.test(text) || /<TitleBar[\s/>]/.test(text)) {
            offenders.push(full)
          }
        }
      }
    }
    walk(RENDERER_SRC)
    expect(offenders).toEqual([])
  })
})
