# AGENTS.md

Conventions for coding agents working in this repo.

## Agent skills

### Issue tracker

Issues are tracked as markdown files under `.scratch/<feature-slug>/` (local markdown tracker). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.

### Testing conventions

Path-shape and filesystem rules that keep the unit suite deterministic across Windows and Linux
CI. See `docs/agents/testing.md`.

## Language convention

Source code, comments, commit messages, test code, and test fixtures (e2e fixtures under
`e2e/fixtures/`) are English only. Chinese is reserved for human-facing prose (README,
CONTRIBUTING, ADR, and the `CONTEXT.md` glossary that maps the app's localized UI strings).
Default test data to `*.en.md`, not `*.zh-CN.md`.
