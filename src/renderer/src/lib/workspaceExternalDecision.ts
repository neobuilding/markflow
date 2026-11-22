import { isInFolder } from '../../../../shared/fileUtils'
import { baseName, dirName, markdownExtOf } from './utils'
import { navigateToPath } from './documentNavigation'
import { switchWorkspace } from './workspaceSwitch'
import { useUIStore } from '../store/ui'
import type { WorkspaceExternalChoice } from '../../../../shared/linkTypes'

/**
 * The shared four-way decision for a Markdown file that resolves OUTSIDE the current workspace,
 * no matter which entry point found it (preview link, drag-drop, file association, menu open).
 *
 * All branches run in the CURRENT window except "new-window", which hands the file to the main
 * process (a second BrowserWindow, reusing one whose workspace already contains it). Crucially
 * this service does NOT run an unsaved guard itself: each branch delegates to the single guard
 * point in navigateToPath / switchWorkspace (Q30), which only prompt when the current document is
 * actually being closed. "new-window" and "cancel" leave this window untouched.
 */
export async function decideExternalFile(filePath: string): Promise<WorkspaceExternalChoice> {
  const choice = await window.api.dialog.confirmWorkspaceExternal(filePath)
  switch (choice) {
    case 'new-window':
      await window.api.app.openInNewWindow(filePath)
      break
    case 'keep-workspace':
      await navigateToPath(filePath, { openMode: 'external-keep' })
      break
    case 'switch-workspace':
      // "Open it here and move the workspace to its folder": the workspace swap AND the file
      // itself. `openPath` is what makes the chosen file the active document — without it the
      // swap would keep (or close) the PREVIOUS document and never open what the user picked.
      await switchWorkspace(dirName(filePath), {
        openMode: 'external-switch',
        openPath: filePath,
        title: baseName(filePath),
      })
      break
    case 'cancel':
      break
  }
  return choice
}

/**
 * Intercept a batch of opened paths BEFORE the normal `useOpenPaths` funnel. Only a single
 * Markdown file that resolves OUTSIDE the current workspace goes through the four-way choice;
 * folders, multi-file batches, non-Markdown files, and workspace-internal files are left for the
 * caller's normal open flow (D18/Q29). Returns true when the paths were fully handled here.
 *
 * The dirty guard is intentionally NOT run here (Q30): each of decideExternalFile's branches
 * delegates to its own close path, which guards only when the current document is actually closed.
 */
export async function maybeDecideExternalPaths(paths: string[]): Promise<boolean> {
  if (paths.length !== 1) return false
  const filePath = paths[0]
  if (!markdownExtOf(filePath)) return false
  const ui = useUIStore.getState()
  const root = ui.workspaceRoot ?? (await window.api.documents.getWorkspaceRoot())
  if (!root || isInFolder(filePath, root)) return false
  await decideExternalFile(filePath)
  return true
}
