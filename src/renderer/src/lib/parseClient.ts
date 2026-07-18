// 渲染进程侧的解析客户端：经 comlink 调用 Worker，失败时降级到主线程
// （复用同一份 markdownPipeline，产出同形状 { html, mermaid }）。
import * as comlink from 'comlink'
import { render, type RenderResult } from '../lib/markdownPipeline'

interface ParseApi {
  parse(content: string, docId: string | null): Promise<RenderResult>
}

let worker: Worker | null = null
let api: comlink.Remote<ParseApi> | null = null
let workerFailed = false

function getApi(): comlink.Remote<ParseApi> {
  if (api) return api
  if (workerFailed) throw new Error('worker unavailable')
  if (!worker) {
    worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), {
      type: 'module',
    })
    api = comlink.wrap<ParseApi>(worker)
  }
  return api!
}

async function fallbackParse(content: string, docId: string | null): Promise<RenderResult> {
  return render(content, docId)
}

// 应用启动时预热 Worker，把冷启动开销移出“打开文档”关键路径。
let warmed = false
export function warmupParseWorker(): void {
  if (warmed) return
  warmed = true
  try {
    const remote = getApi()
    void remote
      .parse('# Warmup\n\n```js\nconsole.log(1)\n```\n', null)
      .catch(() => {})
  } catch {
    // Worker 不可用：真实解析会自动降级主线程，预热失败无影响。
  }
}

export async function parseMarkdown(content: string, docId: string | null): Promise<RenderResult> {
  try {
    const remote = getApi()
    return await remote.parse(content, docId)
  } catch (err) {
    console.warn('[MarkFlow] Worker parse failed, falling back to main thread:', err)
    workerFailed = true
    try {
      return await fallbackParse(content, docId)
    } catch (e) {
      console.error('[MarkFlow] Main-thread parse also failed:', e)
      const msg = e instanceof Error ? e.message : String(e)
      return {
        html: `<p class="text-[var(--color-danger)]">Error rendering preview: ${msg}</p>`,
        mermaid: [],
      }
    }
  }
}
