// Renderer-side parse client: calls the Worker via comlink, falling back to the
// main thread on failure (reusing the same markdownPipeline, producing the same
// { html, mermaid } shape).
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

// Warm up the Worker at app start so its cold-start cost is off the "open document"
// critical path.
let warmed = false
export function warmupParseWorker(): void {
  if (warmed) return
  warmed = true
  try {
    const remote = getApi()
    void remote.parse('# Warmup\n\n```js\nconsole.log(1)\n```\n', null).catch(() => {})
  } catch {
    // Worker unavailable: real parsing auto-falls back to the main thread, so a
    // failed warmup has no impact.
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
