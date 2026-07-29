// English (en) UI translation dictionary — the source of truth and fallback language.
// Keys are dot-namespaced by feature/component. Any key missing from another locale
// falls back to the English string (handled by i18next's fallbackLng: 'en').
// Interpolation uses i18next double-brace placeholders, e.g. {{name}}.
export const en = {
  // ── Sidebar ────────────────────────────────────────────────────────────
  'sidebar.search': 'Search',
  'sidebar.openFile': 'Open File…',
  'sidebar.openFolder': 'Open Folder…',
  'sidebar.newDocument': 'New Document',
  'sidebar.close': 'Close',
  'sidebar.resizeHint': 'Drag to resize sidebar',
  'sidebar.noFolderOpen': 'No folder open',
  'sidebar.openToStart': 'Open a file or folder to start reading.',
  'sidebar.openFileAction': 'Open File…',
  'sidebar.openFolderAction': 'Open Folder…',
  'sidebar.newDocumentAction': 'New Document',
  'sidebar.emptyFolder': 'No documents in this folder',
  'sidebar.createFirst': 'Create your first document',
  'sidebar.details': 'Details',
  'sidebar.delete': 'Delete',

  // ── Editor pane ────────────────────────────────────────────────────────
  'editor.save': 'Save',
  'editor.saveShortcut': 'Save (⌘S)',
  'editor.noChanges': 'No changes to save',
  'editor.saveSwitchEdit': 'Save — switch to Edit mode first',
  'editor.saveAs': 'Save As…',
  'editor.saveAsShortcut': 'Save As… (⌘⇧S)',
  'editor.saveAsSwitchEdit': 'Save As… — switch to Edit mode first',
  'editor.reload': 'Reload from Disk',
  'editor.reloadShortcut': 'Reload from Disk (⌘⇧R)',
  'editor.fileDetails': 'File details',
  'editor.fileDetailsShortcut': 'File details (⌘I)',
  'editor.export': 'Export as HTML…',
  'editor.exportShortcut': 'Export as HTML… (⌘⇧E)',
  'editor.closeFile': 'Close file',
  'editor.toggleSidebarShortcut': 'Toggle Sidebar (⌘\\)',
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

  // ── Command palette ────────────────────────────────────────────────────
  'palette.placeholder': 'Search documents…',
  'palette.searching': 'Searching…',
  'palette.noResults': 'No results for "{{query}}"',
  'palette.startTyping': 'Start typing to search your documents…',
  'palette.navigate': 'navigate',
  'palette.open': 'open',

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
  'details.size': 'Size',
  'details.created': 'Created',
  'details.modified': 'Modified',
  'details.wordCount': 'Word count',
  'details.words': '{{wordCount}} words',
  'details.close': 'Close',

  // ── New document dialog ────────────────────────────────────────────────
  'new.title': 'New Document',
  'new.documentTitle': 'Document title',
  'new.untitled': 'Untitled',
  'new.cancel': 'Cancel',
  'new.create': 'Create',

  // ── App-level (native confirm / alert strings) ─────────────────────────
  'app.unsavedSwitch': 'You have unsaved changes. Discard them and switch files?',
  'app.unsavedCloseWorkspace': 'You have unsaved changes. Discard them and close the workspace?',
  'app.unsavedClose': 'You have unsaved changes. Discard them?',
  'app.saveFailed': 'Failed to save the file.',
  'app.fileGone': 'The file no longer exists on disk.',
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

  // ── Native menu (Electron main process) ────────────────────────────────
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.help': 'Help',
  'menu.language': 'Language',
  'menu.english': 'English',
  'menu.chinese': '简体中文',
  'menu.newDocument': 'New Document',
  'menu.openFile': 'Open File…',
  'menu.openFolder': 'Open Folder…',
  'menu.save': 'Save',
  'menu.saveAs': 'Save As…',
  'menu.reload': 'Reload from Disk',
  'menu.fileDetails': 'File Details…',
  'menu.exportHtml': 'Export as HTML…',
  'menu.print': 'Print…',
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
} as const

export type TranslationKey = keyof typeof en
