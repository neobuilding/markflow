// Renderer-side parse client: calls the Worker via comlink, falling back to the
// main thread on failure (reusing the same markdownPipeline, producing the same
// { html, mermaid } shape).
import * as comlink from 'comlink'
// Type-only on purpose: a VALUE import here would put `markdownPipeline` into the
// renderer's STATIC import graph (see fallbackParse below).
import type { RenderResult } from '../lib/markdownPipeline'

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

// Loaded ON DEMAND, never eagerly: `markdownPipeline` pulls in `katex` (~546 kB) and
// `highlight.js` (~921 kB). A static import here put both into the renderer's static
// graph, so Vite emitted them as `modulepreload` links in index.html and they were
// downloaded on first paint even though the normal path never executes them (the Worker
// owns its own copy of the pipeline). The fallback only runs when the Worker is
// unavailable, so paying a dynamic import there is strictly better.
async function fallbackParse(content: string, docId: string | null): Promise<RenderResult> {
  const { render } = await import('../lib/markdownPipeline')
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
