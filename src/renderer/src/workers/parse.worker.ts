// 解析 Worker：在 Web Worker 内运行 markdown-it 管线，返回 { html, mermaid }。
// 经 comlink 暴露 parse() 给渲染进程（markdown-render-v2-simple 设计）。
import * as comlink from 'comlink'
import { render, type RenderResult } from '../lib/markdownPipeline'

const api = {
  async parse(content: string, docId: string | null): Promise<RenderResult> {
    return render(content, docId)
  },
}

export type ParseApi = typeof api

comlink.expose(api)
