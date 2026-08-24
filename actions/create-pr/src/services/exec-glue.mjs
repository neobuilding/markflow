// Re-export of node:child_process' execFileSync.
//
// This thin indirection exists so tests can mock the exec boundary at the
// module level: vitest (rolldown ESM) cannot reliably intercept a *named*
// import straight from the `node:child_process` builtin, but it can mock a
// project-local module like this one. The GitService and GhService import
// execFileSync from here, so their tests mock './exec-glue.mjs' instead of the
// builtin. At runtime this is a zero-cost pass-through.
export { execFileSync } from 'node:child_process'
