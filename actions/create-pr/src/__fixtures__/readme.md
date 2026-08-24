# Test fixtures

This directory holds **sample data for unit tests only**. It is NOT runtime
code and must never be imported by the published Action (`dist/index.mjs`).

These fixtures are consumed by `loader.test.mjs` via filesystem path
(`join(__dirname, '__fixtures__', ...)`), not via `import`. They exist to
exercise `loadBlocks` / `buildBlockRegistry` against controlled, edge-case
plugin directories:

- `blocks/` — a "healthy" plugin directory:
  - `good.mjs`: a valid block plugin (default export is a function).
  - `notafn.mjs`: default export is `123` (not a function); the loader must
    skip it without crashing.
  - `readme.md`: an intentionally non-`.mjs` file; the loader must ignore it.
- `blocks-broken/` — a "broken" plugin directory to verify loader resilience:
  - `broken.mjs`: throws `Error` on import; loader skips it, run stays alive.
  - `broken-nomsg.mjs`: throws a plain string on import; loader's catch branch
    must fall back to `String(err)` (no `.message`).
  - `ok.mjs`: a valid plugin kept as the "should survive" control.

Do not add production code here. Keep fixtures minimal and self-documenting.
