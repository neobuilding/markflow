# ADR-0025: UI review round 2 (2026-10-30) — pane toolbars, visual identity, and the token single-source rule

The 2026-10-27 refactor (C1–C15) landed and was faithful to both the design text and the plan, yet
the running UI still read as "差别好大" (very different) against the review diagrams. This ADR
records the second review round: what the user actually wanted, the evidence it was measured
against, the decisions taken, the defects found, and the modification plan. It exists so the
reasoning survives — the first round failed precisely because a decision was recorded in code but
not in its own rationale.

- **Status:** Accepted
- **Decided:** 2026-10-30
- **Supersedes:** nothing
- **Reverses:** the design doc §4 rule R3 ("预览不提供常驻顶部工具条") and that doc's
  single-shared-top-band layout model.
- **Amends:** ADR-0024 §1.1 (rewritten), §1.3 (rewritten), §5.3 (extended), §7.1 (rewritten).
- **Related:** `docs.local/MarkFlow-UI-Review-Final-2026-10-13_1/README-revised-2026-10-27.md`,
  `docs.local/PLAN-ui-refactor-2026-10-27.md`.

---

## 1. Requirement

The user's asks, after two rounds of interview:

| #   | Requirement                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a | The **editor pane and the preview pane each own their own toolbar** ("形态 B" — "form B"), instead of one shared top band plus a floating preview-only find widget          |
| R-b | The preview pane toolbar comes back as a **persistent** bar with the **full four** controls: find / export HTML / copy / `…` more                                           |
| R-c | Adopt the **cool-blue visual system** from the diagrams, and move spacing / density toward the diagrams' roomier feel ("the design diagrams look much better than the app") |
| R-d | Keep CJK on the **system font stack**; do not bundle a webfont                                                                                                              |

---

## 2. Evidence

### 2.1 The layout divergence was documented, not a defect

The figure note (图注) in `README-revised` §4 declares the diagrams (2026-10-13) older than the text and lists what
overrides them — including "预览**不提供**常驻顶部工具条". `PLAN` §0.2 C20 chose "只回写文字、
**不重画插图**" (rewrite the text only; do not redraw the artwork). The code followed the text.
**Neither the plan nor the implementation was wrong**; the divergence is text-versus-artwork, and
the artwork was deliberately never redrawn.

### 2.2 The removal rested on a false premise

The preview bar was deleted after being described to the user as "常驻顶部工具条不可见，里面没有任何
按钮" (the persistent top toolbar is invisible and contains no buttons). 图 02 draws a
**populated** preview band (find / export / copy / more). The premise is false against the artwork
it claims to describe. A decision taken on a misreading of its own artefact is undone, not
defended.

### 2.3 Measured palette — extracted from the SVG fills, not eyeballed

From `docs.local/…/images/*.svg` (`fill="#…"`, unique values):

```
accent   #2563eb (blue-600)      tint      #eaf2ff
pages    #f4f7fb #f5f7fb #f6f8fc #f7f9fc #f8fafd #f3f5f8 #edf2f9
text     #1f2937  #637083  #68778d  #8893a2  #94a3b8
semantic #16845b (ok)  #c63d45 (danger)  #b66a00 / #b66a09 (warn)
other    #7756d8  #fff0f0  #fff4df  #ffffff
font     "Noto Sans CJK SC, Microsoft YaHei, sans-serif"
```

The diagrams' "better looking" is **systemic**: cool-tinted page backgrounds plus a slate text
ramp plus a cool-blue accent, versus the app's neutral-grey chrome with a foreign indigo pinned
onto it.

### 2.4 Contrast (WCAG 1.4.3) — computed, not assumed

| pair                   | ratio   | verdict                              |
| ---------------------- | ------- | ------------------------------------ |
| `#94a3b8` on `#f5f7fb` | 2.39:1  | **fail** — the artwork's lightest    |
| `#8893a2` on `#f5f7fb` | < 4.5:1 | **fail**                             |
| `#637083` on `#f5f7fb` | 4.69:1  | pass — the only shippable muted step |
| `#8893a2` on `#0f1419` | 5.95:1  | pass (dark)                          |

So the artwork's lightest slate steps are **not shippable on light**. Copying the palette verbatim
would re-introduce the exact violation ADR-0024 §7.1 / C12 removed (`#9b9b9b` at 2.59:1).

### 2.5 Code measurements

- **35 usages** of raw Tailwind palette utilities (`text-accent`, `bg-accent`, `border-accent`,
  `ring-accent`, `bg-accent/20`, `border-accent/40`, `shadow-accent/20`) across ~15 files.
- `tailwind.config.cjs` still carries `text.tertiary: #9b9b9b` — the **failing value C12 removed**.
  The two token sources have therefore **already drifted**.
- Tailwind's hardcoded hex **cannot respond to `.dark`** — a hex literal is the same value in both
  themes (in Tailwind v4 the `dark:` variant comes from
  `@custom-variant dark (&:where(.dark, .dark *))`, not from a `darkMode` config key), so those 35
  spots are identical in both themes today.
- `.focus-ring` appears in **6** places; **15** `outline-none` remain, including
  `EditorPane.tsx:1013` with `focus:ring-0` — **no focus indicator at all** (WCAG 2.4.7).
- Icons are **11–14px** (`Search size={13}`, `FileText size={14}`, `Replace size={11}`) while the
  design doc §2 mandates **16–18px**; toolbar rows are `h-7` (28px) versus the mandated **32–36px**.
  **Implemented 2026-10-31 (PLAN C23):** the chrome main controls now wear 16px icons with
  32–36px hit areas and the two pane bars are `h-9`; menu/list glyphs stay 13px on purpose — see
  ADR-0024 §1.3 for the pinned numbers.

---

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Form B**: two peer toolbars, each attached to its own pane, plus a slim global top bar                                                                                                                                |
| D2  | Preview pane bar carries the **full four**: find / export HTML / copy / `…` more (adopting 图 02)                                                                                                                       |
| D3  | The global top bar **stays mounted** in single- and split-pane alike, carrying nav / file / save / export / `view-mode`                                                                                                 |
| D4  | Adopt the diagrams' **cool-blue system**; the normative token table lives in ADR-0024 §1.1                                                                                                                              |
| D5  | Light-theme muted text collapses onto `#637083`; `#94a3b8` (2.39:1) and `#8893a2` are **forbidden** on light                                                                                                            |
| D6  | Density loosens: 12px dominant gap, `h-9` rows, radius +1 step, softer shadows — **the sidebar is an exception and stays compact** (192px floor + a ≥80px query field)                                                  |
| D7  | CJK stays on the system stack; the diagrams' `Noto Sans CJK SC` is unbundled and is **not adopted**                                                                                                                     |
| D8  | Icons go to **16px**, hit areas to **32–36px** (design doc §2)                                                                                                                                                          |
| D9  | **Single source of truth for tokens**: `tailwind.config.cjs` references the CSS variables **directly** — in Tailwind v4 an alpha modifier compiles to `color-mix(...)`, so the v3 channel-variable idiom is unnecessary |

---

## 4. Defect register

| #   | Severity | Defect                                                                                                                                                                                                                                                                                                                                                                                                            | Fix                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| F1  | blocker  | **Two sources of truth** for the palette (`globals.css` variables + hardcoded hex in `tailwind.config.cjs`), already drifted (`tertiary: #9b9b9b`). 35 Tailwind utility usages do not follow the variables, and cannot respond to dark mode                                                                                                                                                                       | D9 — Tailwind references the variables                 |
| F2  | blocker  | `bg-accent/20`, `border-accent/40`, `ring-accent/30`, `shadow-accent/20` exist today, so the token reference must keep the alpha intact. **Mechanism corrected 2026-10-31 (PLAN C27):** the original worry — "a plain `var()` makes `/alpha` silently fail" — was a Tailwind **v3** premise; in v4 a plain `var()` compiles to `color-mix(in oklab, var(--color-accent) 20%, transparent)` and the alpha survives | Reference the variable directly — no channel variables |
| F3  | medium   | Icons 11–14px and buttons 28px, both below the design doc §2 mandate of 16–18px / 32–36px                                                                                                                                                                                                                                                                                                                         | D8                                                     |
| F4  | medium   | C11 ("use `.focus-ring` everywhere") is **half done**: 15 `outline-none` sites remain; `EditorPane.tsx:1013` has `focus:ring-0`, i.e. no indicator at all (WCAG 2.4.7); `ui/input.tsx` paints border + ring, i.e. two indicators (breaches ADR-0024 §7.2)                                                                                                                                                         | Convert each to `.focus-ring`                          |
| F5  | medium   | Design doc §4 empty-state rule **contradicts itself**: it lists New/Open in the minimum set and then, in the very next note, says they must not be added                                                                                                                                                                                                                                                          | Keep "must not"; drop them from the list               |
| F6  | medium   | Design doc §12 revision row R3 still states "preview has no persistent bar", **contradicting** the already-updated §4 in the same file                                                                                                                                                                                                                                                                            | Mark R3 reversed                                       |
| F7  | medium   | Design doc §2 contrast / type-size clauses quote **stale values** (`#9b9b9b` at 2.59:1; `text-2xs` at 10px)                                                                                                                                                                                                                                                                                                       | Update; point at ADR-0024                              |
| F8  | medium   | `PLAN` lists only C1–C19; C16 still says "keep `#5e6ad2`, propose an ink blue" — **superseded by D4**; the plan contains none of form B / palette / density                                                                                                                                                                                                                                                       | PLAN C20–C24 added                                     |
| F9  | low      | The sidebar's compact 28px rows are below the design doc's own 32px hit-area preference (they clear WCAG 2.5.8's 24px)                                                                                                                                                                                                                                                                                            | Recorded as constraint over preference                 |
| F10 | low      | Form B requires the two pane bars to be **peers**; editor and preview bars must share `h-9`, or they are not peers                                                                                                                                                                                                                                                                                                | Pinned in the implementation checklist                 |
| F11 | low      | All eight diagrams are **light-only**; the dark column in ADR-0024 §1.1 is **derived**, not measured                                                                                                                                                                                                                                                                                                              | Annotated in ADR-0024 §1.1                             |
| F12 | low      | Design doc §12's "still to fix in code" list is **fully done** but unmarked, which misleads later readers                                                                                                                                                                                                                                                                                                         | Marked done                                            |

---

### 4.1 Addenda — second verification pass (2026-10-30)

A second pass found three more gaps. None of them would show up in a diff, which is why the first
pass missed them:

| #   | Severity | Finding                                                                                                                                                                                                                                                                                        | Fix |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| F14 | medium   | **No automated contrast guard.** Nothing in `src/` computes or asserts contrast (0 hits for `contrast` / `luminance`). The 4.5:1 floor has now been fought twice — once in C12, and again while adopting the artwork palette, whose own greys fail at 2.39:1. Nothing stops a third regression | C25 |
| F15 | medium   | **`color-scheme` is never declared.** Only JS `prefers-color-scheme` matchMedia is used, and only for the preview. Without `color-scheme` on `:root`, native scrollbars, form controls and spellcheck UI do not follow the dark theme                                                          | C26 |
| F16 | low      | **`forced-colors` (Windows High Contrast) is unhandled** — 0 hits in `src/`. Forced-colors flattens custom colours, which can erase focus rings and borders                                                                                                                                    | C26 |

## 5. Modification plan

### P0 — Documentation consistency (do this first; the round went wrong at the document layer)

1. Design doc §4: fix F5. §12: fix F6 and F12. §2: fix F7 and add a palette clause pointing at
   ADR-0024 §1.1.
2. Design doc: add **§14 (复审记录 / review record, 2026-10-30)** — requirement / evidence / decision summary,
   cross-referencing this ADR.
3. `PLAN`: mark C16 superseded; add round-two **C20–C24**; extend the implementation order and the
   verification checklist with the Tailwind sync item (F1 / F2).
4. `ADR-0024`: annotate the dark column as derived (F11); add icon and hit-area sizes to §1.3 (D8);
   add **§1.5 single-source rule** (D9 / F1 / F2); forbid `focus:ring-0` in §7.2; extend the
   registry with #27–#31.

### P1 — Styling (concentrated, fast to see)

1. `globals.css`: replace every token per ADR-0024 §1.1 (light and dark).
   **Amended 2026-10-31 (PLAN C27):** no `--color-*-rgb` channel variables — Tailwind v4 compiles
   `/alpha` via `color-mix`, so the channel-variable set is unnecessary duplication.
2. `tailwind.config.cjs`: make `colors.*` reference the variables **directly**
   (`accent.DEFAULT: 'var(--color-accent)'`); sync
   `borderRadius` and `boxShadow`; **delete** the hardcoded hexes (including the stale `#9b9b9b`).
   **Amended 2026-10-31 (PLAN C27):** `<alpha-value>` is not used — a bare `var()` keeps the alpha
   in v4.
3. Density: toolbars, dialogs, and the editor/preview chrome move to `h-9`, `gap-3`, `px-3`;
   icons go from 13–14px to **16px** (D8).
   **Implemented 2026-10-31 (PLAN C23):** button sizes `sm` 32px / `md` 36px / icon 32px,
   `ui/input.tsx` 36px, 16px icons on the chrome main controls, radius +1 step
   (`sm 6 / DEFAULT 8 / md 10 / lg 12 / xl 14`), and the `0 2px 8px` shadow family. The `gap-3`
   applies to the **dialog action rows**; the bars keep their tight intra-cluster gap
   (`gap-0.5`), because ADR-0024 §10's width budget (12 items ≈ 420px at 32–36px targets) only
   holds with a small gap between icon buttons.
4. The sidebar stays compact (D6 exception, F9 recorded).
5. Focus: convert the 15 remaining `outline-none` sites to `.focus-ring`, **starting with
   `EditorPane.tsx:1013`** (F4).
6. Verify: recompute contrast against the new backgrounds; walk dark mode; regression-check the
   `/alpha` effects (F2).

### P2 — Layout (form B)

1. `EditorPane`: split into a global bar plus an editor pane bar (source actions move down).
2. Add `components/preview/PreviewToolbar.tsx`: find / export / copy / more. **Amended
   2026-10-31 (decision 方案乙):** find is **inlined** — the button expands the find panel
   anchored under the pane bar and the standalone floating `PreviewFindBar` is removed (its
   behaviour tests migrate to `PreviewToolbar.test.tsx`). Find stays read-only, never replace.
   Keep the `find-surface` class (e2e contract) and add a preview-specific positioning override;
   `.find-surface` itself is shared with the editor's CodeMirror panel and must not change.
3. Split layout: the two bars are peers, each aligned to its pane, **both `h-9`** (F10); the
   global bar remains in single-pane mode (D3).
4. Tests: update `EditorPane.test.tsx` and the affected e2e specs; add preview-bar cases.
   **Implemented 2026-10-31 (C20):** `PreviewToolbar.test.tsx` (27 cases — the migrated `PreviewFindBar` behaviour
   suite, minus the retired "floating widget" layout case, plus the export-visibility case), `EditorPaneBar.test.tsx`
   (12 cases, including **both** collapse stages), `store/editorHistory.test.ts` (6 cases), `EditorPane.test.tsx`
   (the read-only toggle moved to `editor-readonly-btn`, plus the export-button-uniqueness case), and the new
   `e2e/specs/pane-toolbars.e2e.spec.ts` (5 cases: the three-bar structure, export uniqueness / placement, undo-redo
   against the real document history, the in-pane preview find, and the preview copy reaching the system clipboard).

**Order: P0 → P1 → P2.** P1 precedes P2 so the styling lands first and can be eyeballed
immediately, before any structural change.

---

## 6. Verification checklist

- [ ] `tailwind.config.cjs`'s `theme.extend.colors` holds **no hex literal** and `accent.DEFAULT === 'var(--color-accent)'` (F1 gone). **Corrected 2026-10-31 (PLAN C27):** the original check — `grep -rn "text-accent\|bg-accent\|border-accent\|ring-accent" src/` returns nothing — grepped for the wrong thing: those utility classes still exist and now resolve to the variables
- [ ] No hardcoded design hexes remain in `tailwind.config.cjs`
- [ ] Those ~35 spots now follow `.dark` (they did not before)
- [ ] `bg-accent/20`, `border-accent/40` and friends still render at partial alpha (F2 regression — v4 emits `color-mix(...)`, so the alpha is preserved)
- [ ] No `focus:ring-0` anywhere; every focusable control has exactly one visible indicator (WCAG 2.4.7)
- [ ] Light-theme muted text measured at ≥ 4.5:1; dark theme ≥ 4.5:1
- [ ] Toolbar icons are 16px and buttons ≥ 32px tall
- [ ] In split view the two pane bars are the same height and each aligns to its pane
- [ ] `README-revised` §4 / §12 / §2 contain nothing that contradicts ADR-0024 §1.1
- [ ] A unit test asserts every token pair at ≥ 4.5:1, and reverting `--color-text-tertiary` to `#9b9b9b` makes it fail (F14 / PLAN C25)
- [ ] `color-scheme` is declared on `:root` and `.dark`; native scrollbars follow the theme (F15 / PLAN C26)
- [ ] Focus rings and borders survive Windows `forced-colors` mode (F16 / PLAN C26)
