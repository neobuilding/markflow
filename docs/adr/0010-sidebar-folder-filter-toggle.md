# ADR-0010: Sidebar folder filtering — opt-in "show all folders" toggle

- **Status:** Accepted
- **Decided:** 2026-09 (design confirmed via grill session; implementation pending)

## Context

On `main`, the sidebar tree is built solely from Markdown documents (`buildFileTree(docs, root)`), so
folders that contain no Markdown are simply absent — a calm default. On `feature/context-menus` the tree was
changed to also seed from the on-disk directory listing (`buildFileTree(docs, root, folderDirs)`), showing
every non-hidden folder including empties. Users find the always-show-all view noisy: most folders hold no
Markdown and clutter the sidebar. We want the clean `main` default back, plus a manual escape hatch to reveal
empty folders, a background right-click menu, and a "recently created folder" visibility pin.

## Decision

- **Default = clean (only Markdown-bearing folders).** The sidebar shows a folder iff it contains a Markdown
  document in itself or any descendant (transitive containment). This is exactly `main`'s behavior and is
  achieved by building the tree **without** the `folderDirs` seed.
- **Opt-in toggle, framed as "显示所有文件夹" (show all folders), default OFF.** The toggle controls whether
  `folderDirs` is passed as a seed to `buildFileTree`. OFF → only Markdown-bearing folders (default). ON → all
  non-hidden folders. The toolbar icon button and the background-context-menu checkbox item share one source
  of truth (`useUIStore.showAllFolders`).
- **No persistence of any setting.** `showAllFolders` (and the recently-created set below) live in the
  in-memory Zustand `ui` store only; nothing is written to disk/localStorage. The app restarts to the clean
  default every time. (Project constraint: keep the app lightweight — no settings are persisted, matching the
  existing behavior where only UI language survives restart.)
- **Recently-created folder pin (session-scoped).** Newly created empty folders are force-injected into the
  tree while `showAllFolders` is OFF, so the user can see and populate them immediately. A folder leaves the
  `recentlyCreated` set when it gains its first Markdown document (it then qualifies on its own) or when the
  app restarts. Injection is part of building the tree (the pinned path is seeded); the pin is dropped by a
  small effect once the folder holds Markdown — no extra event wiring. On creation the folder is
  auto-expanded (its parent is expanded the moment naming starts, so the new node is on screen), but
  `activeFolder` is NOT switched. Scroll-into-view was deliberately skipped: it would need per-row refs for
  a marginal gain.
- **Background (empty-area) right-click menu.** The sidebar scroll area gains a right-click menu:
  新建文件夹 / 新建文件 / separator / 显示所有文件夹 (checkbox item). "New file" creates an inline-named
  `.md` at the `activeFolder` root. Refresh and "Open folder" are deliberately omitted — the chokidar
  `folderWatcher` already keeps the tree live, and re-opening the current folder is meaningless. The
  `EmptyState` menu is aligned to the same set.

## Considered Options

- **Toggle direction — "显示所有文件夹" (opt-in, chosen) vs "仅显示 Markdown" (opt-out filter, default ON).**
  Chose opt-in because it matches the dominant file-manager/IDE convention ("Show hidden files", default off),
  keeps the clean view as the unnamed baseline (lowest cognitive load), and avoids framing the full view as the
  "real" one that users feel compelled to uncover. The opt-out variant's only edge — a checked box directly
  explains why folders are hidden — was judged weaker than the convention/baseline arguments. Tooltip text is
  precise to avoid ambiguity: "显示所有文件夹（即使不含 Markdown 文档）".
- **Persist the toggle — localStorage (like language) vs in-memory only (chosen).** Chose in-memory only per
  the project's "persist nothing" lightweight constraint; the choice resets to clean on every launch, which is
  the desired default anyway.

## Consequences

- **Positive:** clean default restores `main`'s calm sidebar; escape hatch is discoverable and conventional;
  new folders are immediately usable; menu behavior is consistent across empty-area and empty-state.
- **Negative:** the toggle is not remembered across restarts (acceptable by design); "显示所有文件夹" wording
  can be misread as "expand the whole tree" if the precise tooltip is dropped — keep the tooltip.
