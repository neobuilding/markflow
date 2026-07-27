// Parse Worker: runs the markdown-it pipeline inside a Web Worker, returning { html, mermaid }.
// Exposes parse() to the renderer via comlink (markdown-render-v2-simple design).
import * as comlink from 'comlink'
import { render, type RenderResult } from '../lib/markdownPipeline'

const api = {
  async parse(content: string, docId: string | null): Promise<RenderResult> {
    return render(content, docId)
  },
}

export type ParseApi = typeof api

comlink.expose(api)
