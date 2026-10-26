import type { TranslationKey } from './en'

// Simplified Chinese (zh-CN) UI translation dictionary.
// Must cover the same keys as en.ts (enforced by the TranslationKey type).
export const zhCN: Record<TranslationKey, string> = {
  // ── Sidebar ────────────────────────────────────────────────────────────
  'sidebar.search': '搜索',
  // 侧栏在这两个面之间切换；二者互斥，因为搜索视图需要整个面板（计划）。
  'sidebar.files': '文件',
  // 「转到文件…」——Quick Open 的触发按钮，同时点明它的搜索范围（）。
  'sidebar.goToFile': '转到文件…',
  'sidebar.searchPanel': '在文件内搜索',
  'sidebar.openFile': '打开文件…',
  'sidebar.openFolder': '打开文件夹…',
  'sidebar.newDraft': '新建草稿',
  'sidebar.close': '关闭',
  'sidebar.resizeHint': '拖动以调整侧边栏宽度',
  'sidebar.noFolderOpen': '未打开文件夹',
  'sidebar.openToStart': '打开文件或文件夹即可开始阅读。',
  'sidebar.openFileAction': '打开文件…',
  'sidebar.openFolderAction': '打开文件夹…',
  'sidebar.emptyFolder': '此文件夹中没有文档',
  'sidebar.createFirst': '创建你的第一个文档',
  'sidebar.newBadge': '新建',
  'sidebar.unsavedDrafts': '未保存草稿',
  'sidebar.details': '详情',
  'sidebar.delete': '删除',
  'sidebar.up': '上层文件夹',
  'sidebar.enter': '进入此文件夹',

  'sidebar.folderNamePlaceholder': '文件夹名称…',
  'sidebar.fileNamePlaceholder': '文件名称…',
  'sidebar.showAllFolders': '显示所有文件夹',
  'sidebar.showAllFoldersHint': '显示所有文件夹（即使不含 Markdown 文档）',
  'sidebar.newFile': '新建文件',
  'app.deleteFolderFailed': '无法将“{{name}}”移到回收站，它可能正被其他程序占用。',
  'app.renameUndoBlocked': '无法撤销改名——原名称已被占用，或文件已被移动。',
  'sidebar.unsupportedExt': '不支持 {{ext}} 扩展名，已改为 .md',
  'sidebar.unsupportedName': '不能包含路径分隔符，已改为 {{name}}',
  // 实时显示（红色边框、回车被拦截）：当输入的名称与即将放入位置的既有条目重名时。
  'sidebar.nameExists': '“{{name}}” 已存在',
  // 在没有扩展名的名称上按回车后显示：尚未写入任何文件，已补上 “.md”，行保持打开以便确认（再次回车才真正创建）。
  'sidebar.missingExt': '未填写扩展名 —— 已补上 “.md”，再次按回车创建',
  // 当提交被主进程以“非重名”的原因拒绝时（如权限错误）显示在该行下方；重名显示为 nameExists。
  'sidebar.createFailed': '无法创建 “{{name}}”。',
  // 对应 VS Code 的 invalidFileNameError：含分隔符或操作系统非法字符，实时拦截，不让它走到提交。
  'sidebar.invalidName': '“{{name}}” 不是合法的文件或文件夹名。',
  'details.unsaved': '未保存（仅存在于内存中）',

  // ── Editor pane ────────────────────────────────────────────────────────
  'editor.save': '保存',
  'editor.saveShortcut': '保存 ({{shortcut}})',
  'editor.noChanges': '没有需要保存的更改',
  'editor.saveSwitchEdit': '保存 — 请先切换到编辑模式',
  'editor.saveAs': '另存为…',
  'editor.saveAsShortcut': '另存为… ({{shortcut}})',
  'editor.saveAsSwitchEdit': '另存为… — 请先切换到编辑模式',
  'editor.reload': '从磁盘重新加载',
  'editor.reloadShortcut': '从磁盘重新加载 ({{shortcut}})',
  'editor.fileDetails': '文件详情',
  'editor.fileDetailsShortcut': '文件详情 ({{shortcut}})',
  'editor.export': '导出为 HTML…',
  'editor.exportShortcut': '导出为 HTML… ({{shortcut}})',
  'editor.findShortcut': '在文档中查找 ({{shortcut}})',
  'editor.replace': '替换',
  'editor.replaceShortcut': '在文档中替换 ({{shortcut}})',
  'editor.closeFile': '关闭文件',
  'editor.renameTitle': '重命名文件',
  'editor.fileDeleted': '文件已在磁盘上删除 —— 保存即可恢复',
  'editor.toggleSidebarShortcut': '切换侧边栏 ({{shortcut}})',
  'editor.goToFileShortcut': '转到文件… ({{shortcut}})',
  'editor.switchReadOnly': '切换到只读模式',
  'editor.switchEdit': '切换到编辑模式',
  'editor.readOnly': '只读',
  'editor.edit': '编辑',
  'editor.noDocument': '未选择文档',
  'editor.openToGetStarted': '打开文件或文件夹以开始使用',
  'editor.loading': '加载中…',
  'editor.notFound': '未找到文档',
  'editor.fmt.h1': '一级标题',
  'editor.fmt.bold': '加粗',
  'editor.fmt.italic': '斜体',
  'editor.fmt.code': '代码',
  'editor.fmt.link': '链接',
  'editor.fmt.list': '列表',
  'editor.fmt.task': '任务',
  'editor.view.editor': '编辑',
  'editor.view.split': '分屏',
  'editor.view.preview': '预览',
  'editor.showInFolder': '在文件夹中显示',
  'editor.openSegmentFolder': '定位到此文件夹',
  'editor.copyPath': '复制路径',
  'editor.copyFullPath': '复制完整路径',
  'editor.copyFileName': '复制文件名',
  'editor.diskChangedTitle': '磁盘上的文件已更改',
  'editor.diskChangedDirty': '该文件已被其他程序修改。重新加载将丢弃你未保存的更改。',
  'editor.diskChangedClean': '该文件已被其他程序修改。是否重新加载以使用磁盘上的最新版本？',
  'editor.ignore': '忽略',
  'editor.reloadBtn': '重新加载',

  // ── Status bar ─────────────────────────────────────────────────────────
  'status.printing': '正在打印…',
  'status.saving': '正在保存…',
  'status.unsaved': '未保存的更改',
  'status.saved': '已保存',
  'status.words': '{{wordCount}} 字',
  'status.encodingInaccurate': '编码可能不准确，点击切换',
  'status.encoding': '编码：{{encoding}}',
  'status.lineEnding': '换行符',
  'status.lineEndingSwitch': '点击切换换行符（CRLF/LF）',
  'status.switchToCrlf': '切换为 CRLF',
  'status.switchToLf': '切换为 LF',
  'status.redetectEncoding': '重新检测编码',
  'status.redetecting': '正在检测…',
  'status.redetectDisabled': '草稿无文件，无法检测编码',

  // ── Command palette ────────────────────────────────────────────────────
  'palette.placeholder': '搜索文档…',
  'palette.searching': '搜索中…',
  'palette.noResults': '未找到与“{{query}}”相关的结果',
  'palette.startTyping': '开始输入以搜索你的文档…',
  'palette.navigate': '导航',
  'palette.open': '打开',

  // ── 搜索视图：范围 ─────────────────────────────────────────────────────
  // 范围是「可见、可用路径表达」的 include / exclude 两行，而不是需要记住的模式位。
  'search.include': '包含',
  'search.includePlaceholder': '例如 ./docs, **/*.md',
  'search.exclude': '排除',
  'search.excludePlaceholder': '例如 ./archive',
  'search.toggleDetails': '搜索详情',
  // 无工作区根时没有可匹配的相对路径，因此禁用而非让它静默失效。
  'search.scopeDisabledNoRoot': '请先打开文件夹，才能使用「包含 / 排除」',
  // Match Case（Aa）。默认关闭 = 不区分大小写，与 VS Code 一致。
  'search.matchCase': '区分大小写',
  // 全词（ab）。默认关闭。判定标准是 UAX #29 词边界，因此中文、日文同样真实生效。
  'search.wholeWord': '全词匹配',
  // 正则（.*）。默认关闭——关闭时查询是完整字面短语（D24）。
  'search.regexp': '使用正则表达式',
  // 正则模式开启时的内联说明：换行写法与锚定语义。
  'search.regexHint':
    '正则模式下用 \\n 匹配换行（含 CRLF）；^ 与 $ 锚定整篇，不支持 (?m) 行级锚定。',
  'search.invalidRegex': '无效的正则表达式：{{message}}',
  'search.regexTimeout': '正则表达式执行超时，已停止搜索',

  // ── 搜索视图：替换 ─────────────────────────────────────────────────────
  'search.toggleReplace': '展开/收起替换',
  'search.replacePlaceholder': '替换为…',
  'search.replace': '替换',
  'search.replaceHere': '此处',
  'search.replaceInFile': '本文件',
  'search.replaceAll': '全部',
  'search.replaceAllConfirm': '将 {{files}} 个文件中的 {{count}} 处替换为「{{replacement}}」？',
  'search.replaceResult': '已在 {{files}} 个文件中替换 {{count}} 处',
  'search.replaceFailures': '有 {{count}} 个文件未能替换，详见报告',
  'search.replaceCancelled': '替换已取消，未写入任何文件',
  // 安全阈值固定且不可配置（计划 D18）。
  'search.replaceAborted':
    '已达到安全上限（{{limit}}），已中止，未写入任何文件。超限项：{{offending}}',
  'search.replaceNoRootDrafts': '请先打开文件夹：内存草稿无法在磁盘上替换',
  // 有未保存修改的文件不参与跨文件替换（D28）：明说，而不是让用户猜为什么少了几处。
  'search.dirtyBufferSkipped': '有未保存修改的文件已跳过：请先保存或放弃更改',
  'search.planning': '正在计算替换…',
  'search.undoReplace': '撤销上次替换',
  'search.undoResult': '已还原 {{count}} 个文件',
  'search.undoUnavailable': '没有可撤销的替换',
  'search.invalidPattern': '{{field}} 中的模式无效：{{pattern}}',
  // 阻断型诊断：显式 ./path 不存在。与「模式无效」分属不同域（§5.8），不得并入同一文案。
  'search.pathNotFound': '找不到路径：{{pattern}}',
  // 非阻断型提示（§5.2 D19）：范围非空时内存草稿被排除，必须在结果区说明。
  'search.draftsExcluded': '已设置「包含 / 排除」范围，内存草稿不参与搜索',
  'search.outOfRootSkipped': '已跳过工作区外的文档',
  'search.matchCap': '部分文档仅显示前 50 处匹配',
  'search.docCap': '仅显示前 200 个文件的匹配',
  'search.multilineUnsupported': '暂不支持多行查询',

  // ── 搜索视图：结果统计 ──────────────────────────────────────────────
  'search.matchCount': '{{count}} 处匹配，分布在 {{files}} 个文件',
  'search.showingFirst': '仅显示前 {{n}} 个文件',
  'search.globHint': '通配符：* ? ** {a,b} [a-z]',
  'search.noResults': '无结果',
  'search.escHint': '收起搜索面板（Esc）',
  'search.clear': '清除搜索',
  'search.focusHint': '聚焦搜索面板（Ctrl/⌘+Shift+F）',

  // ── About dialog ───────────────────────────────────────────────────────
  'about.title': '关于 MarkFlow',
  'about.subtitle': 'Markdown 编辑器',
  'about.copy': '复制',
  'about.copied': '已复制',
  'about.description': '一款隐私优先、本地优先的 Markdown 编辑器。你的数据始终只保存在本机。',
  'about.close': '关闭',

  // ── Export dialog ──────────────────────────────────────────────────────
  'export.title': '导出为 HTML',
  'export.theme': '主题',
  'export.themeCurrent': '当前 ({{theme}})',
  'export.themeLight': '浅色',
  'export.themeDark': '深色',
  'export.inlineImages': '将图片内联到单个文件（base64，可离线使用）',
  'export.saveLocation': '保存位置',
  'export.notSelected': '未选择',
  'export.choose': '选择…',
  'export.imageNote':
    '未内联时，本地图片会改写为相对路径（与 .html 一同分发），而远程 https 图片则保留。',
  'export.failed': '导出失败，请重试。',
  'export.previewNotReady': '预览尚未就绪。请先切换到预览或分屏视图。',
  'export.overwritePrompt': '文件“{{path}}”已存在。确定要覆盖它吗？此操作无法撤销。',
  'export.cancel': '取消',
  'export.overwrite': '覆盖',
  'export.exporting': '正在导出…',
  'export.export': '导出',

  // ── File details dialog ────────────────────────────────────────────────
  'details.title': '文件详情',
  'details.titleField': '标题',
  'details.path': '路径',
  'details.copyPath': '复制路径',
  'details.showInFolder': '在文件夹中显示',
  'details.size': '大小',
  'details.created': '创建时间',
  'details.modified': '修改时间',
  'details.wordCount': '字数',
  'details.words': '{{wordCount}} 字',
  'details.close': '关闭',

  // ── New document dialog ────────────────────────────────────────────────
  'new.title': '新建草稿',
  'new.documentTitle': '文档标题',
  'new.extension': '扩展名',
  'new.untitled': '未命名',
  'new.cancel': '取消',
  'new.create': '创建',

  // ── App-level (native confirm / alert strings) ─────────────────────────
  // {{title}} 点名正在离开的文档：弹窗出现时用户第一个想知道的就是「哪篇没保存」。
  'app.unsavedSwitch': '「{{title}}」有未保存的更改。要丢弃并切换文件吗？',
  // 打开文件夹/文件会替换整个工作区（计划 D14），未保存编辑会丢失。
  'app.unsavedOpenWorkspace': '「{{title}}」有未保存的更改。要丢弃并打开新工作区吗？',
  // 多个互不隶属的目录无法收敛成一个根（D15）：拒绝并列出候选。
  'app.multipleRootsRefused': '这些文件夹没有共同根目录，无法一起打开。请逐个打开：',
  // 多个目录收敛到共同祖先（D15）：根被静默改掉会清空旧工作区，必须明示新根是什么。
  'app.commonAncestorRoot': '已打开多个文件夹，工作区根已设为共同文件夹：{{root}}',
  // 另存为到当前根之外会重定根（计划）。
  'app.saveAsReroot':
    '该位置在当前工作区之外。保存后会关闭当前工作区并切换到目标文件夹。是否继续？',
  'app.confirmContinue': '继续',
  'app.unsavedCloseWorkspace': '你有未保存的更改。要丢弃并关闭工作区吗？',
  'app.unsavedClose': '你有未保存的更改。要丢弃吗？',
  'app.confirmDiscard': '丢弃',
  'app.confirmKeep': '继续编辑',
  'app.saveFailed': '保存文件失败。',
  'app.fileGone': '该文件在磁盘上已不存在。',
  'app.deleteConfirm': '确定要删除此文件吗？',
  'app.discardDraftConfirm': '确定要丢弃此草稿吗？此操作不可撤销。',
  'app.deleteConfirmOk': '删除',

  'app.deleteFolderConfirm': '确定要将「{{name}}」及其中的全部内容移到回收站吗？',

  'app.switchEolConfirm': '确定要将换行符切换为 {{eol}} 吗？',
  'app.switchEolDetail': '文件将被重写并从磁盘重新加载，未保存的更改会丢失。',
  'app.switchEolOk': '切换',
  'app.cancel': '取消',
  // 调用方未传 okText 时，应用模态确认框的兜底文案
  'app.ok': '确定',
  'app.printNotReady': '预览尚未就绪。请先切换到预览或分屏视图。',
  'app.printFailed': '打印失败：{{message}}',
  'app.preparingPrint': '正在准备打印…',

  // ── Error boundary ────────────────────────────────────────────────────
  'error.title': '出错了',
  'error.message': '应用程序遇到了意外错误。请尝试重新加载——你的数据是安全的。',
  'error.reload': '重新加载应用',

  // ── Preview (injected fallback messages) ───────────────────────────────
  'preview.mermaidFailed': 'Mermaid 渲染失败',
  'preview.imageFailed': '图片加载失败',
  'preview.imageFailedAlt': '图片加载失败：{{alt}}',
  'preview.find': '在预览中查找',
  'preview.findPlaceholder': '在预览中查找…',
  'preview.findPrev': '上一个匹配',
  'preview.findNext': '下一个匹配',
  'preview.findClose': '关闭查找',
  'preview.findNone': '无匹配',

  // ── Native menu (Electron main process) ────────────────────────────────
  'menu.file': '文件',
  'menu.edit': '编辑',
  'menu.view': '视图',
  'menu.window': '窗口',
  'menu.help': '帮助',
  'menu.language': '语言',
  'menu.english': 'English',
  'menu.chinese': '简体中文',
  'menu.newDraft': '新建草稿',
  'menu.openFile': '打开文件…',
  'menu.openFolder': '打开文件夹…',
  'menu.save': '保存',
  'menu.saveAs': '另存为…',
  'menu.reload': '从磁盘重新加载',
  'menu.fileDetails': '文件详情…',
  'menu.exportHtml': '导出为 HTML…',
  'menu.print': '打印…',
  'menu.closeFile': '关闭文件',
  'menu.closeWorkspace': '关闭工作区',
  'menu.toggleSidebar': '切换侧边栏',
  'menu.togglePreview': '切换预览',
  'menu.toggleDevTools': '切换开发者工具',
  'menu.about': '关于 MarkFlow',
  'menu.selectAll': '全选',
  // Electron `role` 项的文案。显式给出而不依赖 Electron 内置 role 文案：后者跟随*系统*语言，
  // 用户在应用内切换到中文时它们仍是英文。role 仍负责行为与平台快捷键，这里只覆盖文字。
  'menu.undo': '撤销',
  'menu.redo': '重做',
  'menu.cut': '剪切',
  'menu.copy': '复制',
  'menu.paste': '粘贴',
  'menu.resetZoom': '实际大小',
  'menu.zoomIn': '放大',
  'menu.zoomOut': '缩小',
  'menu.toggleFullScreen': '切换全屏',
  'menu.minimize': '最小化',
  'menu.zoom': '缩放',
  'menu.quit': '退出',
  'menu.closeWindow': '关闭窗口',
  'menu.dlgOpenFile': '打开 Markdown 文件',
  'menu.dlgOpenFolder': '打开文件夹（批量导入 .md 文件）',
  'menu.filterMarkdown': 'Markdown',
  'menu.filterAllFiles': '所有文件',
  'menu.filterHtml': 'HTML',

  // ── Context menus (ctx.*) ─────────────────────────────────────────────
  // 44

  'ctx.undo': '撤销',
  'ctx.redo': '重做',
  'ctx.cut': '剪切',
  'ctx.copy': '复制',
  'ctx.paste': '粘贴',
  'ctx.selectAll': '全选',
  'ctx.openLinkInBrowser': '在浏览器中打开链接',

  'ctx.openLink': '打开链接',
  'ctx.copyLink': '复制链接地址',

  'ctx.copyImage': '复制图片',
  'ctx.saveImageAs': '图片另存为…',
  'ctx.copyImageSrc': '复制图片地址',

  // Mermaid
  'ctx.copySvg': '复制为 SVG',

  // 公式（KaTeX）
  'ctx.copyFormulaImage': '复制公式为图片',

  'ctx.openDocument': '打开',
  'ctx.copyFileName': '复制文件名',
  'ctx.copyContent': '复制文档内容',
  'ctx.discardDraft': '丢弃草稿',

  'ctx.openFolder': '打开此文件夹',
  // 把搜索视图的「包含」设为该文件夹相对根的路径（计划 D8）——与 VS Code 的「在文件夹中查找」同源。
  'ctx.searchInFolder': '在此文件夹中搜索',
  'ctx.expand': '展开',
  'ctx.collapse': '折叠',
  'ctx.expandAll': '全部展开',
  'ctx.copyFolderPath': '复制文件夹路径',
  'ctx.newFileHere': '新建文件',
  'ctx.newSubfolder': '新建文件夹',

  'ctx.newFolderHere': '新建文件夹',
  'ctx.renameFolder': '重命名文件夹…',
  'ctx.deleteFolder': '删除文件夹',
  'ctx.refresh': '刷新',

  'ctx.goUp': '向上到父文件夹',
  'ctx.openFolderInSidebar': '在侧边栏中打开此文件夹',

  'ctx.copyWordCount': '复制字数',
  'ctx.redetectEncoding': '重新检测编码',
  'ctx.switchToLf': '切换为 LF',
  'ctx.switchToCrlf': '切换为 CRLF',
  'ctx.copyLineEnding': '复制换行符名称',
  'ctx.copyEncoding': '复制编码名称',

  'ctx.copyTitle': '复制标题',
  'ctx.copyResultPath': '复制文件路径',

  'ctx.copyVersion': '复制版本号',
  'ctx.copyVersionFull': '复制名称与版本',

  'ctx.resetSplit': '重置分栏为 50%',
  'ctx.resetSidebarWidth': '重置侧边栏宽度',
  'ctx.collapseSidebar': '折叠侧边栏',

  'editor.needsEditMode': '请先切换到编辑模式',

  // ── Find widget（编辑器与预览共用）───────────────────────────────────
  'find.placeholder': '查找',
  'find.replacePlaceholder': '替换',
  'find.toggle.case': '区分大小写',
  'find.toggle.wholeWord': '全字匹配',
  'find.toggle.regex': '使用正则表达式',
  'find.toggle.preserveCase': '保留大小写',
  // 切换组上的可见字形：Aa / ab / .* / AB
  'find.toggle.caseShort': 'Aa',
  'find.toggle.wholeWordShort': 'ab',
  'find.toggle.regexShort': '.*',
  'find.toggle.preserveCaseShort': 'AB',
  'find.prev': '上一个匹配',
  'find.next': '下一个匹配',
  'find.close': '关闭查找',
  'find.replace': '替换',
  'find.replaceAll': '全部替换',
  'find.noResults': '无匹配',
  // 计数器的 aria-live 文案，例如「3 / 12」
  'find.results': '{{current}} / {{total}}',
}
