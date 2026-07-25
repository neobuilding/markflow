// 导出管线（R7）：把预览“净化后 HTML”复用为单一数据源，支持图片内联与写文件。
// 渲染进程负责拼装完整 HTML（内联 github-markdown-css / katex.css / 主题），
// 本文件仅做两件主进程专属的事：
//  1) export:embed-images —— 把 <img> 的 appdoc:// 或 https: 源内联为 base64 data URL；
//  2) export:write —— 把最终 HTML 写到用户选定路径。
// 图片读取 / 网络抓取都必须在主进程（渲染进程 sandbox 无 Node API）。
import type { IpcMain } from 'electron'
import { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { getDb } from '../db/database'
import { isSubdir, APPDOC_MIME, parseAppDocUrl } from '../lib/security'
import { dirname, extname, resolve, join } from 'path'

function b64(buf: Buffer): string {
  return buf.toString('base64')
}

// 单张图内联：返回 data URL；失败/不需内联返回 null（保留原 src）。
async function inlineOne(src: string): Promise<string | null> {
  try {
    if (/^data:/i.test(src)) return null
    if (/^appdoc:\/\//i.test(src)) {
      // appdoc://<docId>/<相对路径>：docId 落在 hostname（见 parseAppDocUrl 注释）。
      const parsed = parseAppDocUrl(src)
      if (!parsed) return null
      const { docId, relPath: rel } = parsed
      const row = getDb().prepare('SELECT file_path FROM documents WHERE id = ?').get(docId) as
        | { file_path: string }
        | undefined
      if (!row) return null
      const base = dirname(row.file_path)
      const resolved = resolve(base, rel)
      if (!isSubdir(base, resolved) || !existsSync(resolved)) return null
      const buf = readFileSync(resolved)
      return `data:${APPDOC_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream'};base64,${b64(buf)}`
    }
    if (/^https?:/i.test(src)) {
      const res = await fetch(src) // 主进程 Node 全局 fetch
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      const ct = res.headers.get('content-type') ?? 'image/png'
      return `data:${ct};base64,${b64(buf)}`
    }
    return null
  } catch {
    return null
  }
}

export function registerExportHandlers(ipcMain: IpcMain): void {
  // 关键坑：String.prototype.replace 的回调一旦标记为 async 会返回 Promise，
  //   replace 会把它序列化为 "[object Promise]" 当作替换串，导致 HTML 损坏。
  //   故用 exec 循环逐个 await，再拼接结果串。
  ipcMain.handle('export:embed-images', async (_e, html: string): Promise<string> => {
    const RE = /<img([^>]*?)src="([^"]+)"([^>]*)>/gi
    let out = ''
    let last = 0
    let m: RegExpExecArray | null
    while ((m = RE.exec(html)) !== null) {
      const [full, pre, src, post] = m
      out += html.slice(last, m.index)
      const dataUrl = await inlineOne(src)
      out += dataUrl
        ? `<img${pre}src="${dataUrl}"${post}>`
        : full // 内联失败：保留原 <img>（远程图导出后仍可联网显示）
      last = m.index + full.length
    }
    out += html.slice(last)
    return out
  })

  ipcMain.handle('export:write', (_e, path: string, html: string): void => {
    writeFileSync(path, html, 'utf-8') // html 为 utf-8 字符串（含原始编码声明的 <meta>）
  })

  // 共用：把渲染层拼装好的完整 HTML 丢进隐藏 BrowserWindow，等渲染完成
  // （readyState==='complete'，内联大图绘制完毕）后弹出系统打印对话框，
  // 由用户选择目标（实体打印机 / “另存为 PDF”）、纸张尺寸与边距。
  // 这是真实的打印功能（用户明确要求，不做降级为 PDF 导出）；导出字节统一 UTF-8。
  // 改进④：用临时文件 loadFile 替代 data: URL —— 规避大文档（多图 base64 内联）
  //   超出 Chromium 对 data: URL 的长度上限而静默截断/失败；临时文件打印后删除。
  function mapPrintFailureReason(reason?: string): string {
    if (!reason) return '打印失败'
    const lower = reason.toLowerCase()
    if (lower.includes('invalid printer settings')) {
      return '系统默认打印机设置无效，或未安装可用打印机。请检查 Windows 的“打印机和扫描仪”，或将“Microsoft Print to PDF”设为默认打印机后再试。'
    }
    return reason
  }

  async function openPrintDialog(html: string): Promise<void> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const tmp = join(tmpdir(), `mf-print-${process.pid}-${Date.now()}.html`)
    try {
      writeFileSync(tmp, html, 'utf-8')
      await win.loadFile(tmp)
      await win.webContents
        .executeJavaScript(
          'new Promise(r => { if (document.readyState === "complete") r(); else window.addEventListener("load", r) })'
        )
        .catch(() => {})
      // Windows 下系统打印对话框是父窗口的模态框；若父窗口完全隐藏（show:false），
      // 对话框会失去前台焦点、表现为“点了没反应”。但把窗口放到屏幕外(-10000,-10000)
      // 会让某些打印机驱动（含 Microsoft Print to PDF）在初始化时拿到无效监视器信息，
      // 从而全部报 Invalid printer settings。因此把窗口放到有效屏幕坐标、最小化，
      // 既能保证打印对话框正常前置弹出，又不会在界面上闪白/干扰用户。
      win.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      win.show()
      win.minimize()
      win.focus()
      // 注：早期版本曾被“页首多余横线”困扰，一度误判为系统打印对话框的“页眉和页脚”
      // 分隔线、并试图用 Electron 43 已移除的 headerFooterEnabled 去关。实测证明该线并非
      // 系统层产生（对话框里并无此设置，关闭也无效）：它是渲染侧 `<hr>` 的 CSS 缺陷所致——
      // 旧规则 `height:0; overflow:visible` + GitHub 的 `.markdown-body`/`hr` 的
      // `::before`/`::after` clearfix 伪元素，在某些打印引擎里会在页首渲染出一条残线。
      // 该问题已在 renderer 的打印 CSS（src/renderer/src/lib/export.ts 的 @media print）里
      // 通过“隐藏 clearfix 伪元素 + 用实心背景色 + print-color-adjust:exact 还原 hr”解决，
      // 与系统打印对话框无关，也无需用户手动取消任何勾选。这里保持真实打印、不降级为 PDF。
      // Electron 43 在 Windows 上存在回归：传入 deviceName/pageSize/margins 等选项时，
      // 某些系统会统一报 Invalid printer settings；故第一步只传最安全的空对象，
      // 失败后再依次尝试带 printBackground、以及指定 deviceName 的回退。
      const tryPrint = async (
        options: Electron.WebContentsPrintOptions
      ): Promise<{ type: 'success' | 'cancel' | 'error'; reason?: string }> => {
        return new Promise((resolve) => {
          try {
            win.webContents.print(options, (success: boolean, reason?: string) => {
              if (success) resolve({ type: 'success' })
              else if (reason && /cancel/i.test(reason)) resolve({ type: 'cancel' })
              else resolve({ type: 'error', reason })
            })
          } catch (e) {
            resolve({ type: 'error', reason: e instanceof Error ? e.message : String(e) })
          }
        })
      }

      const emptyOutcome = await tryPrint({})
      if (emptyOutcome.type === 'success' || emptyOutcome.type === 'cancel') return
      console.error(`[export:print] 空选项打印失败: ${emptyOutcome.reason ?? 'unknown'}`)

      const bgOutcome = await tryPrint({ printBackground: true })
      if (bgOutcome.type === 'success' || bgOutcome.type === 'cancel') return
      console.error(`[export:print] 带背景打印失败: ${bgOutcome.reason ?? 'unknown'}`)

      // 回退：空选项也失败时，枚举打印机并按“默认 → PDF → 其他”顺序依次指定 deviceName 重试。
      // 把 getPrintersAsync 放在回退路径里，避免常见路径因枚举打印机而阻塞。
      const printers = await win.webContents.getPrintersAsync().catch(() => [])
      if (printers.length === 0) {
        throw new Error(
          '系统中没有检测到任何打印机，无法打印。请在 Windows“设置 → 蓝牙和设备 → 打印机和扫描仪”中添加打印机后再试。'
        )
      }
      const isDefaultPrinter = (p: (typeof printers)[number]): boolean =>
        (p as unknown as { isDefault?: boolean }).isDefault === true
      const defaults = printers.filter(isDefaultPrinter)
      const rest = printers.filter((p) => !isDefaultPrinter(p))
      const score = (name: string): number => {
        if (/microsoft print to pdf/i.test(name)) return 0
        if (/print to pdf/i.test(name)) return 1
        if (/pdf/i.test(name)) return 2
        return 3
      }
      rest.sort((a, b) => score(a.name) - score(b.name))
      const ordered = [...defaults, ...rest]

      // 依次尝试候选打印机：成功或用户取消即结束；某台失败（非取消）则换下一台。
      const attempts: { name: string; reason?: string }[] = []
      for (const candidate of ordered) {
        const outcome = await new Promise<{ type: 'success' | 'cancel' | 'error'; reason?: string }>(
          (resolve) => {
            try {
              win.webContents.print(
                {
                  printBackground: true,
                  deviceName: candidate.name,
                  pageSize: 'A4',
                  margins: { marginType: 'default' },
                },
                (success: boolean, reason?: string) => {
                  if (success) resolve({ type: 'success' })
                  // 用户取消打印对话框不算失败，静默结束即可。
                  else if (reason && /cancel/i.test(reason)) resolve({ type: 'cancel' })
                  else resolve({ type: 'error', reason })
                }
              )
            } catch (e) {
              resolve({ type: 'error', reason: e instanceof Error ? e.message : String(e) })
            }
          }
        )
        if (outcome.type === 'success' || outcome.type === 'cancel') return
        // 记录本次失败原因，供候选耗尽时汇总；同时输出到主进程日志便于调试。
        attempts.push({ name: candidate.name, reason: outcome.reason })
        console.error(`[export:print] 打印机 "${candidate.name}" 初始化失败: ${outcome.reason ?? 'unknown'}`)
      }
      // 所有候选均失败：汇总每台打印机的失败原因，方便用户/开发者判断是保护模式还是单台驱动问题。
      const summary = attempts
        .map((a, i) => `${i + 1}. “${a.name}”: ${mapPrintFailureReason(a.reason)}`)
        .join('\n')
      throw new Error(
        `无法初始化任何可用打印机。已尝试：\n${summary}\n\n请检查 Windows 的“打印机和扫描仪”，或将“Microsoft Print to PDF”设为默认打印机后再试。`
      )
    } finally {
      win.destroy()
      try {
        unlinkSync(tmp)
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  // 打印：弹出系统打印对话框，由用户选实体打印机 / 份数 / 边距 / 目标（可另存为 PDF）。
  // 失败（含打印机设置无效、无可用打印机等）如实向上抛出，由渲染层提示，不做静默降级。
  // 注意：这是真实打印功能，不会降级为“导出 PDF 文件”。
  ipcMain.handle('export:print', async (_e, html: string): Promise<void> => {
    await openPrintDialog(html)
  })
}
