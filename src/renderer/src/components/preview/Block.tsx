// 单个预览块（设计 §8 / §4.3）。按 type 分支渲染：
//   - mermaid：专用组件 MermaidBlock（消费 block.raw 懒渲染）
//   - 其余：轻量 dangerouslySetInnerHTML（已在 Worker 净化）
// 块根元素挂 data-block-id（滚动同步据此定位，§4.7）；
// 每块套 content-visibility:auto + contain-intrinsic-size（§3）。
import React from 'react'
import type { Block } from '../../lib/markdownEngine'
import { MermaidBlock } from './MermaidBlock'

export function Block({ block }: { block: Block }): React.ReactElement {
  const style: React.CSSProperties = {
    contentVisibility: 'auto',
    containIntrinsicSize: '0 600px',
  }

  if (block.type === 'mermaid') {
    return (
      <div data-block-id={block.id} className="markflow-block" style={style}>
        <MermaidBlock code={block.raw ?? ''} />
      </div>
    )
  }

  return (
    <div
      data-block-id={block.id}
      className="markflow-block"
      style={style}
      dangerouslySetInnerHTML={{ __html: block.html }}
    />
  )
}
