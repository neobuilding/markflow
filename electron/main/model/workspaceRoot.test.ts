// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { resolve } from 'node:path'
import {
  getWorkspaceRoot,
  setWorkspaceRoot,
  getWorkspaceSession,
  __resetWorkspaceRootForTests,
} from './workspaceRoot'

beforeEach(() => {
  __resetWorkspaceRootForTests()
})

describe('workspaceRoot (ADR-0023)', () => {
  it('starts with no root', () => {
    expect(getWorkspaceRoot()).toBeNull()
  })

  it('stores exactly one root — setting another REPLACES it', () => {
    // The stored value is normalised with `resolve`, so compare against the same normalisation
    // (on Windows `resolve('/a')` is drive-absolute).
    setWorkspaceRoot('/a')
    expect(getWorkspaceRoot()).toBe(resolve('/a'))
    setWorkspaceRoot('/b')
    expect(getWorkspaceRoot()).toBe(resolve('/b'))
  })

  it('clears the root when given null', () => {
    setWorkspaceRoot('/a')
    setWorkspaceRoot(null)
    expect(getWorkspaceRoot()).toBeNull()
  })

  it('treats empty input as "no root" rather than the current directory', () => {
    // `resolve('')` would silently mean "the process cwd", which is never a workspace the user
    // chose to open.
    setWorkspaceRoot('')
    expect(getWorkspaceRoot()).toBeNull()
  })

  it('bumps the session only when the root actually changes', () => {
    setWorkspaceRoot('/a')
    const first = getWorkspaceSession()
    // Re-opening the same folder must NOT invalidate plans that legitimately describe it.
    expect(setWorkspaceRoot('/a')).toBe(false)
    expect(getWorkspaceSession()).toBe(first)
    setWorkspaceRoot('/b')
    expect(getWorkspaceSession()).toBe(first + 1)
  })
})
