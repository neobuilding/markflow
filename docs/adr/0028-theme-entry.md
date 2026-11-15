# ADR-0028: Deep theme entry — a 主题 submenu with 浅色 / 深色 / 跟随系统

Before this change the only theme control was a single checkbox in the settings UI, and the renderer
store defaulted to `light`. There was no fast, discoverable, in-menu way to switch themes, no
"follow the OS" option, and the native shell (title bar / OS chrome) never tracked the app theme.

- **Status:** Accepted
- **Decided:** 2026-11-03
- **Supersedes:** nothing
- **Reverses:** nothing
- **Amends:** `src/renderer/src/store/ui.ts` (`theme` default), `src/renderer/src/App.tsx` (theme effect)
- **Related:** `electron/main/menu.ts` (View submenu), `electron/main/handlers/theme.ts` (nativeTheme bridge)

---

## 1. Requirement

| #   | Requirement                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- |
| R-a | Add a **主题 (Theme)** submenu under 视图 (View) with three mutually-exclusive choices.               |
| R-b | The three choices are **浅色 / 深色 / 跟随系统 (Light / Dark / System)**, presented as a radio group. |
| R-c | Default to **跟随系统 (System)** on first launch.                                                     |
| R-d | When **跟随系统** is chosen, the app tracks the OS dark/light preference live (no restart).           |
| R-e | The native shell (Electron title bar / OS chrome) follows the chosen theme too.                       |
| R-f | **No persistence**: the choice is not written to disk; each launch starts from the default.           |

---

## 2. Evidence

- Live OS following is the expected behaviour of every modern editor (VS Code, Typora, Zed): a "System"
  theme that does nothing when the OS flips is a known paper-cut.
- Native-theme bridge: `electron/main/handlers/theme.ts` already exposes `app:set-theme` →
  `nativeTheme.themeSource`. `nativeTheme.themeSource = 'system'` makes the OS shell follow the
  platform automatically, so sending the _raw_ choice (even `'system'`) to nativeTheme is correct and
  is all the native shell needs.
- The native menu is built once at startup (`setupMenu`). A radio `checked` state therefore cannot read
  the renderer's live `theme` unless main mirrors it. The store has **no `persist` middleware**
  (verified in `ui.ts`), so "no persistence" is also consistent with the project's existing posture.

---

## 3. Decision

1. `store/ui.ts` `theme` default becomes `'system'`.
2. `menu.ts` View submenu gains a **主题** submenu: three `type: 'radio'` items
   (`menu.themeLight` / `menu.themeDark` / `menu.themeSystem`), each `click` →
   `getMainWindow()?.webContents.send('menu:set-theme', value)`. The `checked` flag reads a module-level
   `currentTheme` mirroring the renderer.
3. Renderer flow:
   - `App.tsx` registers `window.api.onMenuEvent('set-theme', (theme) => setTheme(theme))` — the
     renderer store is the **single source of truth** for the value; the native menu only _forwards_
     the pick, and main never decides the theme on its own.
   - A `theme` effect resolves `system` via `window.matchMedia('(prefers-color-scheme: dark)')` and
     **re-applies on OS change** (listener added only while `theme === 'system'`).
   - The same effect bridges `window.api.app.setTheme(theme)` so the native shell follows and main's
     `applyThemeToMenu(theme)` rebuilds the menu's radio `checked`.
4. **No persistence** — by deliberate decision and user instruction. Trade-off accepted: a user who
   always wants Dark must reselect it each launch; this keeps the surface area small and matches the
   store's existing no-persist posture.

---

## 4. Consequences

- Theme is now reachable from the menu in one click and follows the OS live when set to System.
- The native title bar tracks the app theme (previously only the in-app `.dark` class did).
- Menu radio reflect the current choice; switching theme rebuilds the menu (cheap, same path as the
  existing language switch).
- **Omission acknowledged:** preferences are not remembered across launches. If this proves annoying,
  the future fix is a single `persist`-scoped slice for `theme` only — isolated from the rest of `ui`.
