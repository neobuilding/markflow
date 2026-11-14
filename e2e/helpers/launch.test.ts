// Unit tests for the closeApp failure policy. The decision matrix is pure and
// belongs at the unit layer: reproducing a genuinely hung Electron process in a
// test would be slow and flaky, but the POLICY around a hang is deterministic.
import { describe, it, expect } from 'vitest'
import { classifyCloseFailure, closeFailureError } from './launch'

describe('classifyCloseFailure', () => {
  it('does nothing when the app already exited, even if a timeout flag is set', () => {
    // A clean self-quit makes close() throw; it must never be reported as a hung app.
    expect(classifyCloseFailure({ timedOut: true, alreadyClosed: true, pidAlive: true })).toBe(
      'no-op',
    )
    expect(classifyCloseFailure({ timedOut: false, alreadyClosed: true, pidAlive: false })).toBe(
      'no-op',
    )
  })

  it('fails a timeout even when the process is already gone (nothing to kill)', () => {
    expect(classifyCloseFailure({ timedOut: true, alreadyClosed: false, pidAlive: false })).toBe(
      'fail-timeout-gone',
    )
  })

  it('force-kills AND fails a timeout with a live process', () => {
    expect(classifyCloseFailure({ timedOut: true, alreadyClosed: false, pidAlive: true })).toBe(
      'force-kill-and-fail',
    )
  })

  it('force-kills a non-timeout close error best-effort but does not fail the test', () => {
    expect(classifyCloseFailure({ timedOut: false, alreadyClosed: false, pidAlive: true })).toBe(
      'force-kill',
    )
  })

  it('never kills a recycled PID when a non-timeout error has a dead process', () => {
    expect(classifyCloseFailure({ timedOut: false, alreadyClosed: false, pidAlive: false })).toBe(
      'no-op',
    )
  })

  it('covers the whole 2×2×2 matrix, so no branch is left unchecked', () => {
    const outcomes = new Set<string>()
    for (const timedOut of [true, false]) {
      for (const alreadyClosed of [true, false]) {
        for (const pidAlive of [true, false]) {
          outcomes.add(classifyCloseFailure({ timedOut, alreadyClosed, pidAlive }))
        }
      }
    }
    expect([...outcomes].sort()).toEqual(
      ['fail-timeout-gone', 'force-kill', 'force-kill-and-fail', 'no-op'].sort(),
    )
  })
})

describe('closeFailureError', () => {
  const cause = new Error('electronApp.close() timed out')

  it('preserves the original error as cause (preserve-caught-error)', () => {
    for (const outcome of ['fail-timeout-gone', 'force-kill-and-fail'] as const) {
      expect(closeFailureError(outcome, 15_000, 'x', cause).cause).toBe(cause)
    }
  })

  it('names the timeout and the underlying error in both branches', () => {
    const killed = closeFailureError('force-kill-and-fail', 15_000, 'boom', cause)
    expect(killed.message).toContain('15000ms')
    expect(killed.message).toContain('force-killed the Electron process tree')
    expect(killed.message).toContain('Underlying error: boom')
    expect(killed.message).toContain('test FAILURE')

    const gone = closeFailureError('fail-timeout-gone', 15_000, 'boom', cause)
    expect(gone.message).toContain('the process was already gone')
    expect(gone.message).toContain('Underlying error: boom')
    expect(gone.message).toContain('test FAILURE')
  })
})
