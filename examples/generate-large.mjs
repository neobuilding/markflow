// Regenerates the bilingual large-doc performance fixtures in THIS directory:
//   examples/demo-large.zh-CN.md   (lang: zh-CN, Chinese body)
//   examples/demo-large.en.md      (lang: en,    English body)
// Run from repo root:  node examples/generate-large.mjs
//
// No external deps: the PNGs are hand-rolled (zlib only) so the fixture is reproducible
// offline. The .md files are built from arrays/parameterised functions keyed by language,
// so the Chinese and English versions stay structurally identical (same counts, same R9
// tall-image probe) — only the human-readable text differs. This lets the e2e perf spec
// copy demo-large.en.md and exercise the English export `<html lang>` path while keeping a
// Chinese sibling for the zh-CN path.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(HERE, 'assets')

// ── PNG helpers ────────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, 'ascii')
  const cb = Buffer.alloc(4)
  cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([len, tb, data, cb])
}
function png(w, h, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    for (let x = 0; x < w; x++) {
      raw[o++] = rgb[0]
      raw[o++] = rgb[1]
      raw[o++] = rgb[2]
    }
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
// Tall local image (R9 probe): horizontal colour bands compress well (small file) but its
// 2000px height makes the first-screen layout shift obvious until intrinsic size is backfilled.
function pngTall(w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const palette = [
    [3, 102, 214],
    [6, 214, 160],
    [214, 51, 108],
    [240, 173, 78],
  ]
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    const c = palette[Math.floor(y / 50) % palette.length]
    for (let x = 0; x < w; x++) {
      raw[o++] = c[0]
      raw[o++] = c[1]
      raw[o++] = c[2]
    }
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

fs.mkdirSync(ASSETS, { recursive: true })
fs.writeFileSync(path.join(ASSETS, 'pic-64.png'), png(64, 64, [3, 102, 214]))
fs.writeFileSync(path.join(ASSETS, 'pic-320x200.png'), png(320, 200, [6, 214, 160]))
fs.writeFileSync(path.join(ASSETS, 'pic-800x400.png'), png(800, 400, [214, 51, 108]))
fs.writeFileSync(path.join(ASSETS, 'pic-tall.png'), pngTall(600, 2000))

// ── document ────────────────────────────────────────────────────────────────────
const N_MERMAID = 60
const N_IMAGES = 60
const N_CHAPTERS = 100
const IMGS = ['pic-64.png', 'pic-320x200.png', 'pic-800x400.png']
const LANGS = [
  'python',
  'javascript',
  'typescript',
  'sql',
  'bash',
  'go',
  'rust',
  'json',
  'yaml',
  'java',
]
const cmt = (lang) => (lang === 'en' ? 'example' : '示例')

// Mermaid factories keyed by language (identical structure, localised labels).
const mermaidFns = [
  (i, lang) => {
    const L =
      lang === 'en'
        ? { a: 'block', b: 'decision', y: 'yes', n: 'no', c: 'process', d: 'skip', e: 'end' }
        : { a: '块', b: '判断', y: '是', n: '否', c: '处理', d: '跳过', e: '结束' }
    return `graph TD\n  A[${L.a} ${i}] --> B{${L.b} ${i}}\n  B -->|${L.y}| C[${L.c} ${i}]\n  B -->|${L.n}| D[${L.d} ${i}]\n  C --> E[${L.e} ${i}]`
  },
  (i, lang) => {
    const L =
      lang === 'en'
        ? { u: 'user', s: 'system', r: 'request', p: 'response', ip: 'internal processing' }
        : { u: '用户', s: '系统', r: '请求', p: '响应', ip: '内部处理' }
    return `sequenceDiagram\n  participant U as ${L.u}${i}\n  participant S as ${L.s}${i}\n  U->>S: ${L.r} ${i}\n  S-->>U: ${L.p} ${i}\n  S->>S: ${L.ip} ${i}`
  },
  (i, lang) => {
    const L =
      lang === 'en'
        ? { t: 'task', ph: 'phase', d: 'design', dv: 'develop', te: 'test' }
        : { t: '任务', ph: '阶段', d: '设计', dv: '开发', te: '测试' }
    return `gantt\n  title ${L.t} ${i}\n  dateFormat YYYY-MM-DD\n  section ${L.ph}${i}\n  ${L.d} :a${i}, 2026-01-01, 3d\n  ${L.dv} :b${i}, after a${i}, 5d\n  ${L.te} :c${i}, after b${i}, 2d`
  },
  (i, lang) => {
    const title = lang === 'en' ? `distribution ${i}` : `分布 ${i}`
    return `pie title ${title}\n  "A" : ${(i % 5) + 1}0\n  "B" : ${100 - ((i % 5) + 1) * 10}\n  "C" : 20`
  },
  (i, lang) => {
    const ev = lang === 'en' ? `event${i}` : `事件${i}`
    return `stateDiagram-v2\n  [*] --> S1_${i}\n  S1_${i} --> S2_${i} : ${ev}\n  S2_${i} --> [*]`
  },
  (i) =>
    `classDiagram\n  class C${i} {\n    +field${i}: number\n    +method${i}()\n  }\n  C${i} <|-- D${i}`,
]

// Code samples keyed by language (only the inline comment word is localised).
const codeSamples = {
  python: (i, lang) =>
    `def fn_${i}(n):\n    """${cmt(lang)} ${i}"""\n    return [x * ${i} for x in range(n)]`,
  javascript: (i, lang) =>
    `function fn${i}(n) {\n  // ${cmt(lang)} ${i}\n  return Array.from({ length: n }, (_, x) => x * ${i})\n}`,
  typescript: (i, lang) =>
    `function fn${i}(n: number): number[] {\n  // ${cmt(lang)} ${i}\n  return Array.from({ length: n }, (_, x) => x * ${i})\n}`,
  sql: (i) => `SELECT id, name\nFROM t_${i}\nWHERE active = 1\nORDER BY id DESC\nLIMIT 10;`,
  bash: (i, lang) => {
    const verb = lang === 'en' ? 'processing' : '处理'
    return `#!/bin/bash\n# ${cmt(lang)} ${i}\nfor f in docs/*.md; do\n  echo "${verb} $f (${i})"\ndone`
  },
  go: (i) =>
    `package main\n\nimport "fmt"\n\nfunc fn${i}(n int) []int {\n\tout := make([]int, n)\n\tfor x := 0; x < n; x++ {\n\t\tout[x] = x * ${i}\n\t}\n\treturn out\n}`,
  rust: (i, lang) =>
    `fn fn_${i}(n: usize) -> Vec<usize> {\n    // ${cmt(lang)} ${i}\n    (0..n).map(|x| x * ${i}).collect()\n}`,
  json: (i) => `{\n  "id": ${i},\n  "name": "item-${i}",\n  "active": true\n}`,
  yaml: (i, lang) => `task_${i}:\n  name: ${cmt(lang)} ${i}\n  active: true\n  retries: 3`,
  java: (i, lang) =>
    `public List<Integer> fn${i}(int n) {\n  // ${cmt(lang)} ${i}\n  List<Integer> out = new ArrayList<>();\n  for (int x = 0; x < n; x++) out.add(x * ${i});\n  return out;\n}`,
}

const T = {
  'zh-CN': {
    title: '大文档性能测试 fixture（demo-large）',
    overviewIntro: '自动生成，用于 markflow 预览重构的性能基线测试。覆盖三条优化路径：',
    overviewDE: (n) =>
      `**D-E（Mermaid 缓存 + 懒渲染）**：本节含 ${n} 个图表（含重复图以验证 hash 缓存命中）。`,
    overviewR9: (n) =>
      `**R9（本地图片固有尺寸回填）**：含 ${n} 张本地图（\`appdoc://\`，触发 \`documents:image-size\` IPC）。`,
    overviewDD: (n) => `**D-D（块级增量渲染）**：含 ${n} 个内容各异的章节，压 parse 与块缓存。`,
    overviewLang:
      '**导出 lang（<html lang>）**：frontmatter 设 `lang: zh-CN`，覆盖中文文档导出路径。',
    bigImageTitle: '大图抖动演示（R9 验证）',
    bigImageQuote: [
      '下面两张本地图高度 2000px，且当前**未回填固有尺寸**，首屏会产生明显高度跳变；',
      '这是 R9 要消除的根因。性能用例据此把 `cls` 作为 R9 的硬指标。',
    ],
    bigImg1: '![大图 1](assets/pic-tall.png)',
    bigImg2: '![大图 2](assets/pic-tall.png)',
    featureTitle: '功能覆盖速览',
    featureHeader: '| 功能 | 状态 | 说明 |',
    featureSep: '| --- | --- | --- |',
    featureRows: [
      '| 标准 Markdown | ✅ | 标题、列表、链接、图片 |',
      '| GFM 表格 | ✅ | 表头、对齐、单元格内嵌 |',
      '| Mermaid | ✅ | 流程图/时序/甘特/饼/状态/类图 |',
      '| 代码高亮 | ✅ | 多语言 |',
      '| 数学公式 | ✅ | 行内与块级 |',
      '| 任务列表 | ✅ | GFM 勾选框 |',
    ],
    taskListTitle: '任务列表',
    taskDone1: '已完成项示例',
    taskDone2: '另一项已完成',
    taskTodo1: '待办项示例',
    taskTodo2: '另一项待办',
    mathTitle: '数学公式',
    mathInlineNote: '行内：$E = mc^2$；块级：',
    admonitionTitle: '提示块',
    noteTitle: '注意',
    noteBody: '本地图片应触发固有尺寸回填，避免首屏高度跳变。',
    warningTitle: '警告',
    warningBody: '远程图片不经过 image-size IPC，是已知限制。',
    blockquoteTitle: '引用块',
    quote1: '优秀的工具应该让复杂的事情变简单。',
    quoteNested: '这是嵌套引用，用于测试深层结构。',
    mermaidSectionTitle: 'Mermaid',
    mermaidStressTitle: (n) => `## Mermaid 压力测试（${n} 个）`,
    mermaidStressQuote: '前 20 个为重复图（验证 hash 缓存命中），其余为唯一图。',
    imageStressTitle: (n) => `## 图片压力测试（${n} 张本地图 + 1 张远程图）`,
    imageStressQuote:
      '本地图经 `appdoc://` 解析，触发 `documents:image-size` IPC；远程图仅作对照。',
    localImgAlt: '本地图',
    remoteImgAlt: '远程对照图',
    chapterStressTitle: (n) => `## 章节压力测试（${n} 章）`,
    chapterTitle: (k, cl) => `### 第 ${k} 章 · ${cl} 示例`,
    chapterProse: (k) =>
      `这是第 ${k} 章的示例段落，用于压测块级解析与增量渲染。每个章节包含代码、表格、列表、引用与提示块，模拟真实长文档的结构多样性。`,
    chapterTableHeader: '| 指标 | 值 |',
    chapterTableSep: '| --- | --- |',
    chapterTableRow1: (k) => `| 章节 | ${k} |`,
    chapterTableRow2: (cl) => `| 语言 | ${cl} |`,
    listItem1: (k) => `列表项一（${k}）`,
    listItem2: '列表项二',
    listItem3: '列表项三',
    chapterQuote: (k) => `第 ${k} 章的引用。`,
    chapterTipTitle: (k) => `章节提示 ${k}`,
    chapterTipBody: (cl) => `本章使用 ${cl} 演示块级增量渲染的缓存命中行为。`,
  },
  en: {
    title: 'Large-document performance fixture (demo-large)',
    overviewIntro:
      'Auto-generated performance baseline fixture for the markflow preview refactor. Covers three optimization paths:',
    overviewDE: (n) =>
      `**D-E (Mermaid cache + lazy render)**: this section has ${n} diagrams (including duplicates to verify hash-cache hits).`,
    overviewR9: (n) =>
      `**R9 (local image intrinsic-size backfill)**: has ${n} local images (\`appdoc://\`, triggers the \`documents:image-size\` IPC).`,
    overviewDD: (n) =>
      `**D-D (block-level incremental render)**: has ${n} varied sections, stressing parse and block cache.`,
    overviewLang:
      '**Export lang (<html lang>)**: frontmatter sets `lang: en`, covering the English-doc export path.',
    bigImageTitle: 'Big-image jitter demo (R9 probe)',
    bigImageQuote: [
      'The two local images below are 2000px tall, and their intrinsic size is not yet backfilled, so the first screen jumps in height noticeably;',
      'this is the root cause R9 aims to eliminate. The perf spec uses `cls` as the hard metric for R9.',
    ],
    bigImg1: '![big image 1](assets/pic-tall.png)',
    bigImg2: '![big image 2](assets/pic-tall.png)',
    featureTitle: 'Feature coverage overview',
    featureHeader: '| Feature | Status | Notes |',
    featureSep: '| --- | --- | --- |',
    featureRows: [
      '| Standard Markdown | ✅ | headings, lists, links, images |',
      '| GFM tables | ✅ | header, alignment, cell embedding |',
      '| Mermaid | ✅ | flow / sequence / gantt / pie / state / class diagrams |',
      '| Code highlight | ✅ | multiple languages |',
      '| Math | ✅ | inline and block |',
      '| Task lists | ✅ | GFM checkboxes |',
    ],
    taskListTitle: 'Task lists',
    taskDone1: 'completed example',
    taskDone2: 'another completed',
    taskTodo1: 'todo example',
    taskTodo2: 'another todo',
    mathTitle: 'Math',
    mathInlineNote: 'inline: $E = mc^2$; block:',
    admonitionTitle: 'Admonitions',
    noteTitle: 'Note',
    noteBody:
      'Local images should trigger intrinsic-size backfill to avoid first-screen height jumps.',
    warningTitle: 'Warning',
    warningBody: 'Remote images do not go through the image-size IPC — a known limitation.',
    blockquoteTitle: 'Blockquotes',
    quote1: 'A good tool makes complex things simple.',
    quoteNested: 'This is a nested quote, used to test deep structure.',
    mermaidSectionTitle: 'Mermaid',
    mermaidStressTitle: (n) => `## Mermaid stress test (${n})`,
    mermaidStressQuote:
      'The first 20 are duplicates (to verify hash-cache hits); the rest are unique.',
    imageStressTitle: (n) => `## Image stress test (${n} local + 1 remote)`,
    imageStressQuote:
      'Local images resolve via `appdoc://`, triggering the `documents:image-size` IPC; the remote image is a control only.',
    localImgAlt: 'local image',
    remoteImgAlt: 'remote control image',
    chapterStressTitle: (n) => `## Chapter stress test (${n} chapters)`,
    chapterTitle: (k, cl) => `### Chapter ${k} · ${cl} example`,
    chapterProse: (k) =>
      `This is the sample paragraph for chapter ${k}, used to stress block-level parsing and incremental rendering. Each chapter contains code, tables, lists, quotes and admonitions, simulating the structural variety of a real long document.`,
    chapterTableHeader: '| Metric | Value |',
    chapterTableSep: '| --- | --- |',
    chapterTableRow1: (k) => `| Chapter | ${k} |`,
    chapterTableRow2: (cl) => `| Language | ${cl} |`,
    listItem1: (k) => `list item one (${k})`,
    listItem2: 'list item two',
    listItem3: 'list item three',
    chapterQuote: (k) => `Quote from chapter ${k}.`,
    chapterTipTitle: (k) => `Chapter tip ${k}`,
    chapterTipBody: (cl) =>
      `This chapter uses ${cl} to demonstrate the cache-hit behaviour of block-level incremental rendering.`,
  },
}

function buildDoc(lang) {
  const t = T[lang]
  const lines = []
  lines.push('---')
  lines.push(`lang: ${lang}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${t.title}`)
  lines.push('')
  lines.push(`> ${t.overviewIntro}`)
  lines.push(`> - ${t.overviewDE(N_MERMAID)}`)
  lines.push(`> - ${t.overviewR9(N_IMAGES)}`)
  lines.push(`> - ${t.overviewDD(N_CHAPTERS)}`)
  lines.push(`> - ${t.overviewLang}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // Big-image jitter demo (R9 probe): tall local image whose intrinsic size is not yet
  // backfilled, so the first screen jumps in height noticeably. After R9 backfills
  // width/height, CLS should drop to ~0.
  lines.push(`## ${t.bigImageTitle}`)
  lines.push('')
  lines.push(`> ${t.bigImageQuote[0]}`)
  lines.push(`> ${t.bigImageQuote[1]}`)
  lines.push('')
  lines.push(t.bigImg1)
  lines.push('')
  lines.push(t.bigImg2)
  lines.push('')

  // Feature-coverage overview
  lines.push(`## ${t.featureTitle}`)
  lines.push('')
  lines.push(t.featureHeader)
  lines.push(t.featureSep)
  for (const row of t.featureRows) lines.push(row)
  lines.push('')
  lines.push(`### ${t.taskListTitle}`)
  lines.push(`- [x] ${t.taskDone1}`)
  lines.push(`- [x] ${t.taskDone2}`)
  lines.push(`- [ ] ${t.taskTodo1}`)
  lines.push(`- [ ] ${t.taskTodo2}`)
  lines.push('')
  lines.push(`### ${t.mathTitle}`)
  lines.push(t.mathInlineNote)
  lines.push('')
  lines.push('$$')
  lines.push('\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}')
  lines.push('$$')
  lines.push('')
  lines.push(`### ${t.admonitionTitle}`)
  lines.push(`!!! note "${t.noteTitle}"`)
  lines.push(t.noteBody)
  lines.push('')
  lines.push(`!!! warning "${t.warningTitle}"`)
  lines.push(t.warningBody)
  lines.push('')
  lines.push(`### ${t.blockquoteTitle}`)
  lines.push(`> ${t.quote1}`)
  lines.push('>')
  lines.push(`> > ${t.quoteNested}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // Mermaid stress test
  lines.push(t.mermaidStressTitle(N_MERMAID))
  lines.push('')
  lines.push(`> ${t.mermaidStressQuote}`)
  lines.push('')
  for (let i = 1; i <= N_MERMAID; i++) {
    const fn = i <= 20 ? mermaidFns[0] : mermaidFns[(i - 21) % mermaidFns.length]
    lines.push(`### ${t.mermaidSectionTitle} ${i}`)
    lines.push('')
    lines.push('```mermaid')
    lines.push(fn(i, lang))
    lines.push('```')
    lines.push('')
  }

  // Image stress test
  lines.push(t.imageStressTitle(N_IMAGES))
  lines.push('')
  lines.push(`> ${t.imageStressQuote}`)
  lines.push('')
  for (let i = 1; i <= N_IMAGES; i++) {
    const img = IMGS[i % IMGS.length]
    lines.push(`![${t.localImgAlt} ${i}](assets/${img})`)
    if (i % 10 === 0) lines.push('')
  }
  lines.push('')
  lines.push(
    `![${t.remoteImgAlt}](https://via.placeholder.com/600x200/0366d6/ffffff?text=Remote+Control)`,
  )
  lines.push('')
  lines.push('---')
  lines.push('')

  // Chapter stress test
  lines.push(t.chapterStressTitle(N_CHAPTERS))
  lines.push('')
  for (let k = 1; k <= N_CHAPTERS; k++) {
    const cl = LANGS[(k - 1) % LANGS.length]
    lines.push(t.chapterTitle(k, cl))
    lines.push('')
    lines.push(t.chapterProse(k))
    lines.push('')
    lines.push('```' + cl)
    lines.push(codeSamples[cl](k, lang))
    lines.push('```')
    lines.push('')
    lines.push(t.chapterTableHeader)
    lines.push(t.chapterTableSep)
    lines.push(t.chapterTableRow1(k))
    lines.push(t.chapterTableRow2(cl))
    lines.push('')
    lines.push(`- ${t.listItem1(k)}`)
    lines.push(`- ${t.listItem2}`)
    lines.push(`- ${t.listItem3}`)
    lines.push('')
    lines.push(`> ${t.chapterQuote(k)}`)
    lines.push('')
    lines.push(`!!! tip "${t.chapterTipTitle(k)}"`)
    lines.push(t.chapterTipBody(cl))
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

for (const lang of ['zh-CN', 'en']) {
  const out = buildDoc(lang)
  const file = path.join(HERE, `demo-large.${lang}.md`)
  fs.writeFileSync(file, out)
  console.log('doc written:', file, 'bytes=', out.length, 'lines=', out.split('\n').length)
}
console.log('assets written:', fs.readdirSync(ASSETS))
