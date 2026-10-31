# UI control reuse

Before writing a new input, toggle, button, menu, or dialog, check
`src/renderer/src/components/ui/`. If a primitive fits, use it. If none fits, add it there first —
do not hand-roll an equivalent inside a feature component.

## Available primitives

| Primitive                    | Use for                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Button`                     | Any click action. `variant` (`ghost` / `accent`) + `size` (`icon` / `sm`) cover the toolbar.              |
| `Input`                      | Any single-line text field (`h-9`, shared `.focus-ring`). Do not hand-roll a bordered `<input>`.          |
| `Select`                     | Any `<select>`. Wraps the native element (`h-9`, shared `.focus-ring`); do not hand-roll its focus ring.  |
| `SearchInput`                | Every query field: value, placeholder, optional `leadingIcon`, `onClear`, `mainField`.                    |
| `IconToggleGroup`            | Any set of small text toggles (`Aa`, `ab`, `.*`). `testId` is the group id; buttons get `<testId>-<key>`. |
| `InputContextMenu`           | Wraps any text input to give it Cut/Copy/Paste/Undo/Redo/Select-all.                                      |
| `Tooltip` / `TooltipContent` | Icon buttons. Always pair with `aria-label`.                                                              |
| `ContextMenu*`               | Right-click menus anywhere.                                                                               |
| `Dialog`                     | Modal surfaces.                                                                                           |
| `MatchCounter`               | `k / n` match display shared by all find surfaces.                                                        |

## Why this is a rule, not a suggestion

Three find surfaces (editor panel, preview bar, sidebar Search view) each grew their own query
input. They drifted: different focus indicators, different clear buttons, different markup for
the same visual language. They are now one `SearchInput`, and the drift cannot come back as long
as the primitive is the only place the markup lives.

## Review checklist

For any PR touching the renderer UI:

- [ ] Does this reuse `components/ui`, and if not, why?
- [ ] Does a new input carry `.focus-ring` (and its container _not_ also paint a focus border)?
- [ ] Is any text below 11px? (`2xs` is the floor — see ADR-0024 §5.1.)
- [ ] Does a new icon duplicate the glyph of a neighbouring control?

See `docs/adr/0024-ui-convergence-spec.md` §4 for the normative version.
