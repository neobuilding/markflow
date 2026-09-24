# ADR-0022: Unified core↔plugin contract — context object + service injection

- Status: Accepted
- Date: 2026-09-24
- Decided by: @straybugs (with Claude)
- Supersedes-in-part: the "core pre-computes `typeFlags` / `fixes`" design implied
  by ADR-0021's original wording.

## Context

The `create-pr` action renders a PR body from a template plus a set of block
plugins (`title`, `issue`, `commits`, and any user-provided blocks such as
`types`). Originally the render core (`render.mjs`) pre-computed two _domain facts_
in `buildCtx` — `typeFlags` (PR type) and `fixes` (linked issue) — from
`services.git.logSubjects`, then handed them to the plugins as ready-made fields
on `ctx`.

That design leaked domain knowledge into the core: "what a PR type is" and "which
issue is linked" were core concerns, not plugin concerns. It also forced every
plugin's data needs to be anticipated by the core. When we wanted to add `refactor`
/ `test` / `improvement` types, the change touched the core's `classifyChange` and
`buildCtx` rather than staying inside the `types` plugin — exactly the coupling we
wanted to avoid by making blocks plugins in the first place.

We needed a contract where the core stays ignorant of each plugin's data needs,
and adding or changing a block requires **only** editing (or adding) a plugin —
no core change.

## Decision

Adopt a single, stable **`PluginContext`** object as the one parameter passed to
every block plugin, plus **injected, memoized `services`** as the I/O capabilities
the plugin pulls data from. The plugin contract is:

```js
// @typedef {Object} PluginContext
// @property {string} head       resolved head branch name
// @property {string} base       resolved base ref (e.g. `origin/main`)
// @property {string} title      derived PR title
// @property {Object} services   injectable I/O capabilities (git / gh / templateSource)
//
// @typedef {function(PluginContext): (string | Promise<string>)} BlockPlugin
export default (ctx) => string | Promise<string>
```

Principles:

1. **The core never pre-computes domain facts.** `buildCtx` returns only
   `{ head, base, title, services }`. It does not produce `typeFlags` or `fixes`.
   A plugin that needs the PR type or the linked issue computes it itself from
   `ctx.head` + `ctx.services.git`.
2. **Data flows only through the context object (parameterized, not hard-coded).**
   `services` is the set of injectable "capability" parameters; the plugin asks for
   exactly what it needs and nothing is pushed at it.
3. **Caching lives at the I/O boundary, not as pre-aggregated domain facts.**
   `render-template.mjs` wraps the injected git service with a `memoizeGit` helper
   so that however many plugins call `logSubjects` / `logRange` for the same
   `head`/`base`, the real git CLI is spawned at most once per method+args. This
   preserves the old "compute once" performance property without the core having to
   know which facts the plugins need.
4. **Plugins are async-friendly.** A plugin may `await ctx.services.git.*`; the
   renderer (`renderBlock` / `fillAutoBlocks`) awaits the plugin and treats a
   throwing plugin as "plugin missing" (leaves the `{{name}}` placeholder
   untouched) so one bad plugin never aborts a whole render.
5. **Resilience of the loader is preserved** — a user block that fails to load is
   skipped; a block that throws at render time degrades gracefully.

### Why "B1" (service injection + plugin-owned classification) over a heavier

dependency-injection registry

A full DI / derived-data registry (where plugins register named providers that the
core resolves and shares) was considered. It is more "framework-y" but, for an
action of this size, over-engineered: there is exactly one consumer each for
`typeFlags` (the `types` plugin) and `fixes` (the `issue` plugin), so sharing
derived data across plugins adds machinery without a real payoff. B1 keeps the
contract minimal and the plugins fully autonomous, which is the existing spirit of
the code (`commits` was already fetching its own git data). The contract in this
ADR leaves the door open to a registry later if cross-plugin sharing ever appears.

## Consequences

- Adding a new block (or a new PR type / new issue policy) is a **plugin-only**
  change: drop or edit a `.mjs` file. No `render.mjs` / `buildCtx` edit.
- The core no longer imports or references `classifyChange` / `extractFixes`; they
  are inlined inside the `types` / `issue` plugins (there is no core classification
  module). The repo-side `types.mjs` inlines `classifyChange` to stay standalone.
- The git service is memoized once at injection, so moving classification into the
  plugin does not multiply git spawns.
- Tests no longer assert `ctx.typeFlags` / `ctx.fixes`; they drive classification
  the way production does — by supplying `head` + a fake `git` service — which is a
  stronger, more faithful set of tests.
- Coverage gate (ADR-0004) holds: `render.mjs` is still 100% pure, and the plugin git-pulling
  paths (and the inlined `classifyChange`/`extractFixes` logic, exercised via the plugin-driven
  render tests) are covered by unit and end-to-end render tests.
