import { describe, it, expect } from 'vitest'
import {
  TOGGLE_FIELD,
  withToggle,
  type FindToggleState,
  type FindToggleField,
} from './find-toggles'

// The key->field mapping used to be written twice (once in the editor's find panel, once in the
// preview's find bar). It lives here now so the two surfaces can never disagree about what
// `Aa` / `ab` / `.*` mean.
describe('find-toggles', () => {
  const base: FindToggleState = {
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    preserveCase: false,
  }

  it('maps each match toggle to its FindToggleState field', () => {
    expect(TOGGLE_FIELD.case).toBe('caseSensitive')
    expect(TOGGLE_FIELD.word).toBe('wholeWord')
    expect(TOGGLE_FIELD.regex).toBe('regexp')
  })

  it('flips exactly one field and leaves the others (including preserveCase) alone', () => {
    const fields: FindToggleField[] = ['caseSensitive', 'wholeWord', 'regexp']
    fields.forEach((field) => {
      const next = withToggle(base, field, true)
      expect(next[field]).toBe(true)
      // Only the targeted field changed.
      fields.filter((f) => f !== field).forEach((other) => expect(next[other]).toBe(false))
      expect(next.preserveCase).toBe(false)
    })
  })

  it('flips a field back off and never mutates the input state', () => {
    const on = withToggle(base, 'regexp', true)
    const off = withToggle(on, 'regexp', false)
    expect(off.regexp).toBe(false)
    // The original object must be untouched (the reducer-style callers rely on this).
    expect(base.regexp).toBe(false)
    expect(on.regexp).toBe(true)
  })
})
