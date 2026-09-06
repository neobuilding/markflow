import React from 'react'
import { useT } from '../../i18n'
import { ContextMenuItem, ContextMenuSeparator } from '../ui/context-menu'
import {
  PenLine,
  FileText,
  FolderOpen,
  Save,
  SaveAll,
  RotateCcw,
  Info,
  FileOutput,
  Copy,
  ArrowRight,
} from 'lucide-react'

// Shared "file menu" content for the title bar file name and the file-path breadcrumb
// (PLAN §7 / 需求 §5.6, §5.7). The two areas are required to share ONE definition so the
// menus can never drift apart; `variant` picks the block each surface actually shows.
//
//   title  — §5.6: rename | copy name / copy path / reveal | save / save as / reload |
//                  details / export
//   file   — §5.7 last segment: rename | copy name / copy path / reveal | details
//   icon   — §5.7 folder-icon area: reveal / copy path / copy name
//   folder — §5.7 middle segment: open folder in sidebar / reveal / copy folder path
//
// `folder` is a separate prop shape: those three actions target a *directory*, not the open
// document, so passing them through the document-level action set would leave dead callbacks.
export type FileMenuVariant = 'title' | 'file' | 'folder' | 'icon'

export interface DocMenuActions {
  rename: () => void
  copyFileName: () => void
  copyFullPath: () => void
  showInFolder: () => void
  save: () => void
  saveAs: () => void
  reload: () => void
  details: () => void
  exportHtml: () => void
}

export interface FolderMenuActions {
  openInSidebar: () => void
  showInFolder: () => void
  copyPath: () => void
}

type DocMenuProps = {
  variant: 'title' | 'file' | 'icon'
  /** The document has an on-disk path (false for a memory-only draft). */
  hasPath: boolean
  editable: boolean
  dirty: boolean
  actions: DocMenuActions
}

type FolderMenuProps = {
  variant: 'folder'
  folder: FolderMenuActions
}

export type FileMenuItemsProps = DocMenuProps | FolderMenuProps

export function FileMenuItems(props: FileMenuItemsProps): React.ReactElement {
  const { t } = useT()

  if (props.variant === 'folder') {
    return (
      <>
        <ContextMenuItem
          data-testid="ctx-open-folder-in-sidebar"
          onClick={props.folder.openInSidebar}
        >
          <ArrowRight size={13} /> {t('ctx.openFolderInSidebar')}
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-show-in-folder" onClick={props.folder.showInFolder}>
          <FolderOpen size={13} /> {t('editor.showInFolder')}
        </ContextMenuItem>
        <ContextMenuItem data-testid="ctx-copy-folder-path" onClick={props.folder.copyPath}>
          <Copy size={13} /> {t('ctx.copyFolderPath')}
        </ContextMenuItem>
      </>
    )
  }

  const { variant, hasPath, editable, dirty, actions } = props

  const renameItem = (
    <ContextMenuItem
      data-testid="ctx-rename"
      disabled={!editable}
      title={!editable ? t('editor.needsEditMode') : undefined}
      onClick={actions.rename}
    >
      <PenLine size={13} /> {t('editor.renameTitle')}
    </ContextMenuItem>
  )
  const copyFileNameItem = (
    <ContextMenuItem
      data-testid="ctx-copy-filename"
      disabled={!hasPath}
      onClick={actions.copyFileName}
    >
      <Copy size={13} /> {t('editor.copyFileName')}
    </ContextMenuItem>
  )
  const copyFullPathItem = (
    <ContextMenuItem data-testid="ctx-copy-path" disabled={!hasPath} onClick={actions.copyFullPath}>
      <FileText size={13} /> {t('editor.copyFullPath')}
    </ContextMenuItem>
  )
  const showInFolderItem = (
    <ContextMenuItem
      data-testid="ctx-show-in-folder"
      disabled={!hasPath}
      onClick={actions.showInFolder}
    >
      <FolderOpen size={13} /> {t('editor.showInFolder')}
    </ContextMenuItem>
  )
  const detailsItem = (
    <ContextMenuItem data-testid="ctx-details" onClick={actions.details}>
      <Info size={13} /> {t('editor.fileDetails')}
    </ContextMenuItem>
  )

  if (variant === 'icon') {
    return (
      <>
        {showInFolderItem}
        {copyFullPathItem}
        {copyFileNameItem}
      </>
    )
  }

  return (
    <>
      {renameItem}
      <ContextMenuSeparator />
      {copyFileNameItem}
      {copyFullPathItem}
      {showInFolderItem}
      <ContextMenuSeparator />
      {variant === 'title' && (
        <>
          {/* Matches the toolbar save button: saving needs edit mode AND real changes. */}
          <ContextMenuItem
            data-testid="ctx-save"
            disabled={!editable || !dirty}
            onClick={actions.save}
          >
            <Save size={13} /> {t('editor.save')}
          </ContextMenuItem>
          <ContextMenuItem data-testid="ctx-save-as" disabled={!editable} onClick={actions.saveAs}>
            <SaveAll size={13} /> {t('editor.saveAs')}
          </ContextMenuItem>
          {/* Reload re-reads from disk, so a draft (no file) can never do it. */}
          <ContextMenuItem data-testid="ctx-reload" disabled={!hasPath} onClick={actions.reload}>
            <RotateCcw size={13} /> {t('editor.reload')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {detailsItem}
      {variant === 'title' && (
        <ContextMenuItem data-testid="ctx-export-html" onClick={actions.exportHtml}>
          <FileOutput size={13} /> {t('editor.export')}
        </ContextMenuItem>
      )}
    </>
  )
}
