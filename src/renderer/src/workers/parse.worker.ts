// 解析 Worker：在 Web Worker 内运行 unified 管线，返回净化后的 blocks[]。
// 经 comlink 暴露 parse() 给渲染进程（§4.2 / R1）。
import * as comlink from 'comlink'
import { buildBlocks, type Block } from '../lib/markdownEngine'

const api = {
  async parse(content: string, docId: string | null): Promise<Block[]> {
    return buildBlocks(content, docId)
  },
}

export type ParseApi = typeof api

comlink.expose(api)
