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
