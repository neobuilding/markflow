// 单个预览块（设计 §8 / §4.3）。按 type 分支渲染：
//   - mermaid：专用组件 MermaidBlock（消费 block.raw 懒渲染）
//   - 其余：轻量 dangerouslySetInnerHTML（已在 Worker 净化）
// 块根元素挂 data-block-id（滚动同步据此定位，§4.7）。
//
// content-visibility:auto 用于屏外块跳过布局/绘制（性能，O1）。但其“屏外估算高度”
// 若用固定值（如 0 600px）会与块真实渲染高度不符；滚动同步读 getBoundingClientRect
// 会在「屏外(估算)↔屏内(真实)」间跳变，导致预览在 mermaid 等大块处抖动/卡住（问题#2）。
// 故用 contain-intrinsic-size:auto —— 浏览器记住块最后一次真实渲染尺寸，屏外时直接用
// 记忆值（而非固定 600px），跳变消失，且自动适配字体加载/窗口缩放等回流。
// mermaid 块关闭 content-visibility：它本就懒渲染、数量少，关掉可彻底消除大块进入视口时
// 的高度翻转（真实高度始终生效，无 600↔真实 跳变）；其 SVG 就绪前由骨架占位提供稳定最小
// 高度，避免同步把块高读成 ≈0 而卡住（globals.css 的 .mermaid-skeleton）。
import React from 'react'
import type { Block } from '../../lib/markdownEngine'
import { MermaidBlock } from './MermaidBlock'

export function Block({ block }: { block: Block }): React.ReactElement {
  // mermaid 关闭 content-visibility（始终真实高度）；其余块用 auto + 记忆尺寸防跳变。
  const style: React.CSSProperties =
    block.type === 'mermaid'
      ? { contentVisibility: 'visible' }
      : { contentVisibility: 'auto', containIntrinsicSize: 'auto 600px' }

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
