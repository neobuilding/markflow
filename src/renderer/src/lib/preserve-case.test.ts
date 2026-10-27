import { describe, it, expect } from 'vitest'
import { preserveCase } from './preserve-case'

describe('preserveCase', () => {
  it('returns the replacement unchanged when it is empty', () => {
    expect(preserveCase('foo', '')).toBe('')
  })

  it('lowercases the replacement for an all-lower match', () => {
    expect(preserveCase('foo', 'BAR')).toBe('bar')
    expect(preserveCase('foo', 'Bar')).toBe('bar')
  })

  it('uppercases the replacement for an all-upper match', () => {
    expect(preserveCase('FOO', 'bar')).toBe('BAR')
    expect(preserveCase('FOO', 'Bar')).toBe('BAR')
  })

  it('title-cases the replacement for a first-upper (title) match', () => {
    expect(preserveCase('Foo', 'bar')).toBe('Bar')
    expect(preserveCase('Foo', 'BAR')).toBe('Bar')
  })

  it('keeps the replacement verbatim for mixed-case matches', () => {
    expect(preserveCase('fOO', 'bar')).toBe('bar')
  })

  it('keeps the replacement verbatim when the match has no alphabetic first char', () => {
    expect(preserveCase('123abc', 'xyz')).toBe('xyz')
  })

  it('returns the replacement verbatim for an empty match', () => {
    expect(preserveCase('', 'bar')).toBe('bar')
  })
})
