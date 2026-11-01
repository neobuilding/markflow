// Unit tests for the clipboard SPEC POLICY — not for the clipboard itself.
//
// The clipboard IO needs a real OS clipboard (that is what the e2e suite is for), but the policy
// around it is pure: which reason a skip carries. That reason is what a developer reads in a
// report, so it is worth pinning.
import { describe, it, expect } from 'vitest'
import {
  CLIPBOARD_SPEC_SKIP_REASON,
  clipboardSkipMessage,
  type ClipboardSnapshot,
} from './clipboard'

function snapshot(over: Partial<ClipboardSnapshot> = {}): ClipboardSnapshot {
  return { types: ['text/plain'], data: { 'text/plain': 'aGk=' }, restorable: true, ...over }
}

describe('clipboard skip policy', () => {
  it('names the project that may run the clipboard specs', () => {
    expect(CLIPBOARD_SPEC_SKIP_REASON).toContain('e2e-clipboard')
    expect(CLIPBOARD_SPEC_SKIP_REASON).toContain('npm run e2e:clipboard')
  })

  it('points at that project when there is no snapshot (the spec may not run here)', () => {
    expect(clipboardSkipMessage(undefined)).toBe(CLIPBOARD_SPEC_SKIP_REASON)
  })

  it('says why the clipboard was left alone when it cannot be restored', () => {
    const snap = snapshot({
      restorable: false,
      reason: 'clipboard reports text/html but read() returned nothing',
    })
    expect(clipboardSkipMessage(snap)).toBe(
      'clipboard left untouched: clipboard reports text/html but read() returned nothing',
    )
  })

  it('has a fallback reason when the snapshot carries none', () => {
    expect(clipboardSkipMessage(snapshot({ restorable: false }))).toBe(
      'clipboard left untouched: cannot be restored',
    )
  })
})
