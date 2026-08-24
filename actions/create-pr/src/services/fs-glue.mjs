// Re-export of the node:fs functions used by the PR-action services.
//
// Same indirection trick as exec-glue.mjs: vitest (rolldown ESM) cannot
// reliably intercept a named import straight from the `node:fs` builtin, but
// it can mock a project-local module. TemplateSource imports readFileSync and
// the loader imports readdirSync/existsSync from here, so their tests mock
// './fs-glue.mjs' instead of the builtin. Zero-cost pass-through at runtime;
// ncc bundles it into dist/index.mjs.
export { readFileSync, readdirSync, existsSync } from 'node:fs'
