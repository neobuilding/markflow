import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  FileMenuItems,
  type DocMenuActions,
  type FileMenuVariant,
  type FolderMenuActions,
} from './FileMenuItems'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu'
import '../../i18n'

function docActions(): DocMenuActions {
  return {
    rename: vi.fn(),
    copyFileName: vi.fn(),
    copyFullPath: vi.fn(),
    showInFolder: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    reload: vi.fn(),
    details: vi.fn(),
    exportHtml: vi.fn(),
  }
}

function folderActions(): FolderMenuActions {
  return { openInSidebar: vi.fn(), showInFolder: vi.fn(), copyPath: vi.fn() }
}

function mountFolder(a: FolderMenuActions) {
  return render(
    <ContextMenu open onOpenChange={vi.fn()}>
      <ContextMenuTrigger data-testid="trigger">t</ContextMenuTrigger>
      <ContextMenuContent>
        <FileMenuItems variant="folder" folder={a} />
      </ContextMenuContent>
    </ContextMenu>,
  )
}

function mount(
  variant: Exclude<FileMenuVariant, 'folder'>,
  a: DocMenuActions,
  opts: { hasPath?: boolean; editable?: boolean; dirty?: boolean } = {},
) {
  const { hasPath = true, editable = true, dirty = true } = opts
  return render(
    <ContextMenu open onOpenChange={vi.fn()}>
      <ContextMenuTrigger data-testid="trigger">t</ContextMenuTrigger>
      <ContextMenuContent>
        <FileMenuItems
          variant={variant}
          hasPath={hasPath}
          editable={editable}
          dirty={dirty}
          actions={a}
        />
      </ContextMenuContent>
    </ContextMenu>,
  )
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { clipboard: { writeText: vi.fn() } }
})

const ALL_TITLE_IDS = [
  'ctx-rename',
  'ctx-copy-filename',
  'ctx-copy-path',
  'ctx-show-in-folder',
  'ctx-save',
  'ctx-save-as',
  'ctx-reload',
  'ctx-details',
  'ctx-export-html',
]

describe('FileMenuItems — title variant (需求 §5.6)', () => {
  it('renders the full file menu in order', async () => {
    mount('title', docActions())
    for (const id of ALL_TITLE_IDS) {
      expect(await screen.findByTestId(id)).toBeInTheDocument()
    }
  })

  it('invokes every action', async () => {
    const a = docActions()
    mount('title', a)
    for (const id of ALL_TITLE_IDS) {
      fireEvent.click(await screen.findByTestId(id))
    }
    expect(a.rename).toHaveBeenCalled()
    expect(a.copyFileName).toHaveBeenCalled()
    expect(a.copyFullPath).toHaveBeenCalled()
    expect(a.showInFolder).toHaveBeenCalled()
    expect(a.save).toHaveBeenCalled()
    expect(a.saveAs).toHaveBeenCalled()
    expect(a.reload).toHaveBeenCalled()
    expect(a.details).toHaveBeenCalled()
    expect(a.exportHtml).toHaveBeenCalled()
  })

  it('greys out save without edit mode or without changes', async () => {
    mount('title', docActions(), { editable: false, dirty: true })
    expect(await screen.findByTestId('ctx-save')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-save-as')).toHaveAttribute('aria-disabled', 'true')
    // Reload only needs a file on disk, so it stays enabled.
    expect(screen.getByTestId('ctx-reload')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('greys out save when there are no unsaved changes', async () => {
    mount('title', docActions(), { editable: true, dirty: false })
    expect(await screen.findByTestId('ctx-save')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-save-as')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('greys out path items and reload for a memory-only draft', async () => {
    mount('title', docActions(), { hasPath: false })
    expect(await screen.findByTestId('ctx-copy-filename')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-copy-path')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-show-in-folder')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-reload')).toHaveAttribute('aria-disabled', 'true')
    // Details / export stay available for a draft.
    expect(screen.getByTestId('ctx-details')).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('ctx-export-html')).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('greys out rename in read-only mode with a hint', async () => {
    mount('title', docActions(), { editable: false })
    const rename = await screen.findByTestId('ctx-rename')
    expect(rename).toHaveAttribute('aria-disabled', 'true')
    expect(rename).toHaveAttribute('title', 'Switch to edit mode first')
  })
})

describe('FileMenuItems — file (last path segment) variant (需求 §5.7)', () => {
  it('drops the save / save-as / reload / export block', async () => {
    mount('file', docActions())
    expect(await screen.findByTestId('ctx-rename')).toBeInTheDocument()
    expect(await screen.findByTestId('ctx-details')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-save')).toBeNull()
    expect(screen.queryByTestId('ctx-save-as')).toBeNull()
    expect(screen.queryByTestId('ctx-reload')).toBeNull()
    expect(screen.queryByTestId('ctx-export-html')).toBeNull()
  })
})

describe('FileMenuItems — folder (middle path segment) variant (需求 §5.7)', () => {
  it('offers open-in-sidebar / reveal / copy folder path', async () => {
    const a = folderActions()
    mountFolder(a)
    fireEvent.click(await screen.findByTestId('ctx-open-folder-in-sidebar'))
    fireEvent.click(await screen.findByTestId('ctx-show-in-folder'))
    fireEvent.click(await screen.findByTestId('ctx-copy-folder-path'))
    expect(a.openInSidebar).toHaveBeenCalled()
    expect(a.showInFolder).toHaveBeenCalled()
    expect(a.copyPath).toHaveBeenCalled()
  })

  it('does not offer the document-level items', async () => {
    mountFolder(folderActions())
    await screen.findByTestId('ctx-copy-folder-path')
    expect(screen.queryByTestId('ctx-rename')).toBeNull()
    expect(screen.queryByTestId('ctx-copy-path')).toBeNull()
    expect(screen.queryByTestId('ctx-details')).toBeNull()
  })
})

describe('FileMenuItems — icon / blank variant (需求 §5.7)', () => {
  it('offers reveal / copy full path / copy file name in that order', async () => {
    const a = docActions()
    mount('icon', a)
    const menu = await screen.findByRole('menu')
    const labels = Array.from(menu.children).map((c) => c.getAttribute('data-testid'))
    expect(labels).toEqual(['ctx-show-in-folder', 'ctx-copy-path', 'ctx-copy-filename'])
    fireEvent.click(screen.getByTestId('ctx-copy-filename'))
    expect(a.copyFileName).toHaveBeenCalled()
  })
})
