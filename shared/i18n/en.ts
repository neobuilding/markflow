// English (en) UI translation dictionary the source of truth and fallback language
// Keys are dot-namespaced by feature/component. Any key missing from another locale
// falls back to the English string (handled by i18next's fallbackLng: 'en').
// Interpolation uses i18next double-brace placeholders, e.g. {{name}}.
export const en = {
  // ── Sidebar ────────────────────────────────────────────────────────────
  'sidebar.search': 'Search',
  'sidebar.openFile': 'Open File…',
  'sidebar.openFolder': 'Open Folder…',
  'sidebar.newDraft': 'New Draft',
  'sidebar.close': 'Close',
  'sidebar.resizeHint': 'Drag to resize sidebar',
  'sidebar.noFolderOpen': 'No folder open',
  'sidebar.openToStart': 'Open a file or folder to start reading.',
  'sidebar.openFileAction': 'Open File…',
  'sidebar.openFolderAction': 'Open Folder…',
  'sidebar.emptyFolder': 'No documents in this folder',
  'sidebar.createFirst': 'Create your first document',
  'sidebar.newBadge': 'new',
  'sidebar.unsavedDrafts': 'Unsaved drafts',
  'sidebar.details': 'Details',
  'sidebar.delete': 'Delete',
  'sidebar.up': 'Up to parent folder',
  'sidebar.enter': 'Open this folder',
  // Placeholder of the inline <input> used to name a new/renamed folder
  'sidebar.folderNamePlaceholder': 'Folder name…',
  'sidebar.fileNamePlaceholder': 'File name…',
  'sidebar.showAllFolders': 'Show All Folders',
  'sidebar.showAllFoldersHint': 'Show All Folders (even without Markdown)',
  'sidebar.newFile': 'New File',
  // Shown when a folder could not be moved to the Trash (in use / permission denied).
  'app.deleteFolderFailed':
    'Could not move "{{name}}" to the Trash. It may be open in another program.',
  // Shown when a rename cannot be undone (original name taken again, or the file moved on).
  'app.renameUndoBlocked':
    'Cannot undo the rename — the original name is taken or the file has moved.',
  // Shown under the inline name input when what was typed cannot be used as typed.
  'sidebar.unsupportedExt': '"{{ext}}" is not a Markdown extension — changed to .md',
  'sidebar.unsupportedName': 'Path separators are not allowed — changed to "{{name}}"',
  // Shown live (red border, blocked Enter) when the typed name already exists next to where the
  // new entry would land.
  'sidebar.nameExists': '"{{name}}" already exists here',
  // Shown after Enter on a name with no extension: nothing is written yet, ".md" is filled in and
  // the row stays open so the user can confirm (a second Enter actually creates the file).
  'sidebar.missingExt': 'No extension — ".md" was added. Press Enter again to create',
  // Shown under the inline name input when the commit was rejected by the main process for a
  // reason other than a name clash (e.g. a permission error). A clash is shown as nameExists.
  'sidebar.createFailed': 'Could not create "{{name}}".',
  // VS Code's "invalidFileNameError": a separator or an OS-illegal character, flagged live so the
  // commit is never attempted (mkdir is non-recursive, so `a/b` could only fail).
  'sidebar.invalidName': 'The name "{{name}}" is not valid as a file or folder name.',

  // ── Editor pane ────────────────────────────────────────────────────────
  'editor.save': 'Save',
  'editor.saveShortcut': 'Save ({{shortcut}})',
  'editor.noChanges': 'No changes to save',
  'editor.saveSwitchEdit': 'Save — switch to Edit mode first',
  'editor.saveAs': 'Save As…',
  'editor.saveAsShortcut': 'Save As… ({{shortcut}})',
  'editor.saveAsSwitchEdit': 'Save As… — switch to Edit mode first',
  'editor.reload': 'Reload from Disk',
  'editor.reloadShortcut': 'Reload from Disk ({{shortcut}})',
  'editor.fileDetails': 'File details',
  'editor.fileDetailsShortcut': 'File details ({{shortcut}})',
  'editor.export': 'Export as HTML…',
  'editor.exportShortcut': 'Export as HTML… ({{shortcut}})',
  'editor.findShortcut': 'Find ({{shortcut}})',
  'editor.replace': 'Replace',
  'editor.replaceShortcut': 'Replace ({{shortcut}})',
  'editor.closeFile': 'Close file',
  'editor.renameTitle': 'Rename file',
  'editor.fileDeleted': 'Deleted on disk — save to restore it',
  'editor.toggleSidebarShortcut': 'Toggle Sidebar ({{shortcut}})',
  'editor.switchReadOnly': 'Switch to read-only mode',
  'editor.switchEdit': 'Switch to edit mode',
  'editor.readOnly': 'Read-only',
  'editor.edit': 'Edit',
  'editor.noDocument': 'No document selected',
  'editor.openToGetStarted': 'Open a file or folder to get started',
  'editor.loading': 'Loading…',
  'editor.notFound': 'Document not found',
  'editor.fmt.h1': 'H1',
  'editor.fmt.bold': 'Bold',
  'editor.fmt.italic': 'Italic',
  'editor.fmt.code': 'Code',
  'editor.fmt.link': 'Link',
  'editor.fmt.list': 'List',
  'editor.fmt.task': 'Task',
  'editor.view.editor': 'Editor',
  'editor.view.split': 'Split',
  'editor.view.preview': 'Preview',
  'editor.showInFolder': 'Show in folder',
  'editor.openSegmentFolder': 'Go to this folder',
  'editor.copyPath': 'Copy path',
  'editor.copyFullPath': 'Copy full path',
  'editor.copyFileName': 'Copy file name',
  'editor.diskChangedTitle': 'File changed on disk',
  'editor.diskChangedDirty':
    'This file was modified by another program. Reloading will discard your unsaved changes.',
  'editor.diskChangedClean':
    'This file was modified by another program. Reload to load the latest version from disk?',
  'editor.ignore': 'Ignore',
  'editor.reloadBtn': 'Reload',

  // ── Status bar ─────────────────────────────────────────────────────────
  'status.printing': 'Printing…',
  'status.saving': 'Saving…',
  'status.unsaved': 'Unsaved changes',
  'status.saved': 'Saved',
  'status.words': '{{wordCount}} words',
  'status.encodingInaccurate': 'Encoding may be inaccurate, click to switch',
  'status.encoding': 'Encoding: {{encoding}}',
  'status.lineEnding': 'Line ending',
  'status.lineEndingSwitch': 'Click to switch line ending (CRLF/LF)',
  'status.switchToCrlf': 'Switch to CRLF',
  'status.switchToLf': 'Switch to LF',
  'status.redetectEncoding': 'Re-detect encoding',
  'status.redetecting': 'Detecting…',
  'status.redetectDisabled': 'Drafts have no file to detect encoding from',

  // ── Command palette ────────────────────────────────────────────────────
  'palette.placeholder': 'Search documents…',
  'palette.searching': 'Searching…',
  'palette.noResults': 'No results for "{{query}}"',
  'palette.startTyping': 'Start typing to search your documents…',
  'palette.navigate': 'navigate',
  'palette.open': 'open',
  'palette.mode.filename': 'File name',
  'palette.mode.content': 'Content',
  'palette.scopeFolder': 'Current folder and its sub-folders',
  'palette.scopeAll': 'All documents',

  // ── About dialog ───────────────────────────────────────────────────────
  'about.title': 'About MarkFlow',
  'about.subtitle': 'Markdown Editor',
  'about.copy': 'Copy',
  'about.copied': 'Copied',
  'about.description':
    'A privacy-first, local-first Markdown editor. All your data stays on your machine.',
  'about.close': 'Close',

  // ── Export dialog ──────────────────────────────────────────────────────
  'export.title': 'Export as HTML',
  'export.theme': 'Theme',
  'export.themeCurrent': 'Current ({{theme}})',
  'export.themeLight': 'Light',
  'export.themeDark': 'Dark',
  'export.inlineImages': 'Inline images into a single file (base64, works offline)',
  'export.saveLocation': 'Save location',
  'export.notSelected': 'Not selected',
  'export.choose': 'Choose…',
  'export.imageNote':
    'When not inlined, local images are rewritten to relative paths (distributed alongside the .html), while remote https images are kept.',
  'export.failed': 'Export failed. Please try again.',
  'export.previewNotReady':
    'Preview is not ready yet. Please switch to the preview or split view first.',
  'export.overwritePrompt':
    'File "{{path}}" already exists. Are you sure you want to overwrite it? This action cannot be undone.',
  'export.cancel': 'Cancel',
  'export.overwrite': 'Overwrite',
  'export.exporting': 'Exporting…',
  'export.export': 'Export',

  // ── File details dialog ────────────────────────────────────────────────
  'details.title': 'File Details',
  'details.titleField': 'Title',
  'details.path': 'Path',
  'details.copyPath': 'Copy path',
  'details.showInFolder': 'Show in folder',
  'details.unsaved': 'Unsaved (kept in memory only)',
  'details.size': 'Size',
  'details.created': 'Created',
  'details.modified': 'Modified',
  'details.wordCount': 'Word count',
  'details.words': '{{wordCount}} words',
  'details.close': 'Close',

  // ── New document dialog ────────────────────────────────────────────────
  'new.title': 'New Draft',
  'new.documentTitle': 'Document title',
  'new.extension': 'Extension',
  'new.untitled': 'Untitled',
  'new.cancel': 'Cancel',
  'new.create': 'Create',

  // ── App-level (native confirm / alert strings) ─────────────────────────
  'app.unsavedSwitch': 'You have unsaved changes. Discard them and switch files?',
  'app.unsavedCloseWorkspace': 'You have unsaved changes. Discard them and close the workspace?',
  'app.unsavedClose': 'You have unsaved changes. Discard them?',
  'app.confirmDiscard': 'Discard',
  'app.confirmKeep': 'Keep editing',
  'app.saveFailed': 'Failed to save the file.',
  'app.fileGone': 'The file no longer exists on disk.',
  'app.deleteConfirm': 'Delete this file?',
  'app.discardDraftConfirm': 'Discard this draft? This cannot be undone.',
  'app.deleteConfirmOk': 'Delete',
  // Folder deletion : the folder is moved to the OS trash, not erased
  'app.deleteFolderConfirm': 'Move "{{name}}" and everything inside it to the Trash?',
  // Line-ending switch : a destructive rewrite of the file on disk
  'app.switchEolConfirm': 'Switch line endings to {{eol}}?',
  'app.switchEolDetail':
    'The file is rewritten and reloaded from disk, discarding unsaved changes.',
  'app.switchEolOk': 'Switch',
  'app.cancel': 'Cancel',
  'app.printNotReady':
    'Preview is not ready yet. Please switch to the preview or split view first.',
  'app.printFailed': 'Print failed: {{message}}',
  'app.preparingPrint': 'Preparing to print…',

  // ── Error boundary ────────────────────────────────────────────────────
  'error.title': 'Something went wrong',
  'error.message':
    'The application encountered an unexpected error. Try reloading — your data is safe.',
  'error.reload': 'Reload App',

  // ── Preview (injected fallback messages) ───────────────────────────────
  'preview.mermaidFailed': 'Mermaid render failed',
  'preview.imageFailed': 'Image failed to load',
  'preview.imageFailedAlt': 'Image failed to load: {{alt}}',
  'preview.find': 'Find in preview',
  'preview.findPlaceholder': 'Find in preview…',
  'preview.findPrev': 'Previous match',
  'preview.findNext': 'Next match',
  'preview.findClose': 'Close find',
  'preview.findNone': 'No match',

  // ── Native menu (Electron main process) ────────────────────────────────
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.help': 'Help',
  'menu.language': 'Language',
  'menu.english': 'English',
  'menu.chinese': '简体中文',
  'menu.newDraft': 'New Draft',
  'menu.openFile': 'Open File…',
  'menu.openFolder': 'Open Folder…',
  'menu.save': 'Save',
  'menu.saveAs': 'Save As…',
  'menu.reload': 'Reload from Disk',
  'menu.fileDetails': 'File Details…',
  'menu.exportHtml': 'Export as HTML…',
  'menu.print': 'Print…',
  'menu.closeFile': 'Close File',
  'menu.closeWorkspace': 'Close Workspace',
  'menu.toggleSidebar': 'Toggle Sidebar',
  'menu.togglePreview': 'Toggle Preview',
  'menu.toggleDevTools': 'Toggle Developer Tools',
  'menu.about': 'About MarkFlow',
  'menu.dlgOpenFile': 'Open Markdown File',
  'menu.dlgOpenFolder': 'Open Folder (batch import .md files)',
  'menu.filterMarkdown': 'Markdown',
  'menu.filterAllFiles': 'All Files',
  'menu.filterHtml': 'HTML',

  // ── Context menus (ctx.*) ─────────────────────────────────────────────
  // Right-click menu items across all areas. 56 keys, en/zh-CN parity required.
  // Editor
  'ctx.undo': 'Undo',
  'ctx.redo': 'Redo',
  'ctx.cut': 'Cut',
  'ctx.copy': 'Copy',
  'ctx.paste': 'Paste',
  'ctx.selectAll': 'Select All',
  'ctx.openLinkInBrowser': 'Open Link in Browser',
  // Preview link
  'ctx.openLink': 'Open Link',
  'ctx.copyLink': 'Copy Link Address',
  // Preview code block
  'ctx.copyCode': 'Copy Code',
  'ctx.copyCodeBlock': 'Copy as Fenced Block',
  'ctx.copyLang': 'Copy Language',
  // Preview image
  'ctx.copyImage': 'Copy Image',
  'ctx.saveImageAs': 'Save Image As…',
  'ctx.copyImageSrc': 'Copy Image Address',
  'ctx.copyImageAlt': 'Copy Alt Text',
  // Preview table
  'ctx.copyTable': 'Copy Table',
  'ctx.copyTableTsv': 'Copy Table for Spreadsheet',
  // Preview task
  'ctx.copyTaskText': 'Copy Task Text',
  // Preview formula
  'ctx.copyFormula': 'Copy Formula as Text',
  'ctx.copyFormulaSource': 'Copy TeX Source',
  // Preview diagram (mermaid)
  'ctx.copyDiagramSource': 'Copy Diagram Source',
  'ctx.copySvg': 'Copy as SVG',
  'ctx.saveSvgAs': 'Save Diagram As SVG…',
  // Preview heading
  'ctx.copyHeading': 'Copy Heading Text',
  'ctx.copyAnchorId': 'Copy Anchor ID',
  // Sidebar document item
  'ctx.openDocument': 'Open',
  'ctx.copyFileName': 'Copy File Name',
  'ctx.copyContent': 'Copy Document Content',
  'ctx.discardDraft': 'Discard Draft',
  // Sidebar folder row
  'ctx.openFolder': 'Open This Folder',
  'ctx.expand': 'Expand',
  'ctx.collapse': 'Collapse',
  'ctx.expandAll': 'Expand All',
  'ctx.copyFolderPath': 'Copy Folder Path',
  'ctx.newFileHere': 'New File',
  'ctx.newSubfolder': 'New Folder',
  // Current folder bar: create a folder directly under the opened folder.
  'ctx.newFolderHere': 'New Folder',
  'ctx.renameFolder': 'Rename Folder…',
  'ctx.deleteFolder': 'Delete Folder',
  'ctx.refresh': 'Refresh',
  // Current folder bar / breadcrumb
  'ctx.goUp': 'Go to Parent Folder',
  'ctx.openFolderInSidebar': 'Open Folder in Sidebar',
  // Status bar
  'ctx.copyWordCount': 'Copy Word Count',
  'ctx.redetectEncoding': 'Re-detect Encoding',
  'ctx.switchToLf': 'Switch to LF',
  'ctx.switchToCrlf': 'Switch to CRLF',
  'ctx.copyLineEnding': 'Copy Line Ending',
  'ctx.copyEncoding': 'Copy Encoding Name',
  // Search panel
  'ctx.copyTitle': 'Copy Title',
  'ctx.copyResultPath': 'Copy File Path',
  // About dialog
  'ctx.copyVersion': 'Copy Version',
  'ctx.copyVersionFull': 'Copy Name and Version',
  // Drag bars
  'ctx.resetSplit': 'Reset Split to 50%',
  'ctx.resetSidebarWidth': 'Reset Sidebar Width',
  'ctx.collapseSidebar': 'Collapse Sidebar',

  // ── Editor extra ───────────────────────────────────────────────────────
  // Tooltip shown on disabled (read-only) rename/save menu items
  'editor.needsEditMode': 'Switch to edit mode first',
} as const

export type TranslationKey = keyof typeof en
