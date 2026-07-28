import { describe, it, expect, vi, beforeEach } from 'vitest'
import { franc } from 'franc'

// franc is mocked so the deterministic mapping/fallback tests don't depend on
// the statistical model. Each test defaults to the REAL franc (see beforeEach),
// and specific tests override the return value to assert the ISO3->BCP47 mapping.
vi.mock('franc', () => ({ franc: vi.fn() }))

import { extractFrontmatterLang, detectContentLang, resolveExportLang } from './lang'

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('franc')>('franc')
  vi.mocked(franc).mockImplementation(actual.franc)
})

const ZH =
  '我们生活在一个充满变化的时代。技术的进步正在深刻地影响着每一个人的日常生活。学习新知识、适应新环境，已经成为现代人不可或缺的能力。'
const JA =
  '私たちは日々変化する世界に生きている。技術の進歩は人々の暮らしを大きく変えている。新しい知識を学び、環境に適応することが大切である。'
const KO =
  '우리는 변화하는 세계에 살고 있습니다. 기술의 발전은 사람들의 일상생활을 크게 바꾸고 있습니다. 새로운 지식을 배우고 환경에 적응하는 것이 중요합니다.'
const EN =
  "We live in an era of constant change. Technological progress is profoundly affecting everyone's daily life. Learning new knowledge and adapting to new environments has become an essential ability for modern people."

describe('extractFrontmatterLang', () => {
  it('returns null when there is no frontmatter block', () => {
    expect(extractFrontmatterLang('# Hello\n\nNo frontmatter here.')).toBeNull()
  })

  it('returns null when frontmatter exists but has no lang field', () => {
    expect(extractFrontmatterLang('---\ntitle: Hi\ndate: 2024\n---\n\nbody')).toBeNull()
  })

  it('extracts an unquoted lang tag', () => {
    expect(extractFrontmatterLang(`---\nlang: zh-CN\n---\n\n${ZH}`)).toBe('zh-CN')
  })

  it('extracts a double-quoted and a single-quoted lang tag', () => {
    expect(extractFrontmatterLang('---\nlang: "ja"\n---\n')).toBe('ja')
    expect(extractFrontmatterLang("---\nlang: 'ko'\n---\n")).toBe('ko')
  })

  it('returns null for non-BCP47 junk values', () => {
    expect(extractFrontmatterLang('---\nlang: 123\n---\n')).toBeNull()
    expect(extractFrontmatterLang('---\nlang: 你好\n---\n')).toBeNull()
  })

  it('requires the frontmatter block to be at the very start', () => {
    expect(extractFrontmatterLang(`intro\n\n---\nlang: en\n---\n${EN}`)).toBeNull()
  })
})

describe('detectContentLang — real franc (script detection)', () => {
  it('detects Chinese as zh-CN', () => {
    expect(detectContentLang(ZH)).toBe('zh-CN')
  })

  it('detects Japanese as ja', () => {
    expect(detectContentLang(JA)).toBe('ja')
  })

  it('detects Korean as ko', () => {
    expect(detectContentLang(KO)).toBe('ko')
  })

  it('detects English as en', () => {
    expect(detectContentLang(EN)).toBe('en')
  })

  it('falls back to en for empty content', () => {
    expect(detectContentLang('')).toBe('en')
  })

  it('does not let an English code block bias a Chinese document toward English', () => {
    const doc = `${ZH}\n\n\`\`\`js\nconst sum = (a, b) => a + b;\nfunction render() { return items.map(i => i.name); }\n\`\`\``
    expect(detectContentLang(doc)).toBe('zh-CN')
  })

  it('treats code-only content as en rather than misdetecting English', () => {
    expect(detectContentLang('```js\nconst a = 1;\n```')).toBe('en')
  })

  it('strips HTML tags before detection', () => {
    expect(detectContentLang(`<div>${JA}</div>`)).toBe('ja')
  })
})

describe('detectContentLang — deterministic ISO3 -> BCP47 mapping', () => {
  it('maps cmn -> zh-CN', () => {
    vi.mocked(franc).mockReturnValue('cmn')
    expect(detectContentLang('anything')).toBe('zh-CN')
  })

  it('maps jpn -> ja', () => {
    vi.mocked(franc).mockReturnValue('jpn')
    expect(detectContentLang('anything')).toBe('ja')
  })

  it('maps kor -> ko', () => {
    vi.mocked(franc).mockReturnValue('kor')
    expect(detectContentLang('anything')).toBe('ko')
  })

  it('maps eng -> en', () => {
    vi.mocked(franc).mockReturnValue('eng')
    expect(detectContentLang('anything')).toBe('en')
  })

  it('falls back to en for undetermined/unmapped codes', () => {
    vi.mocked(franc).mockReturnValue('und')
    expect(detectContentLang('x')).toBe('en')
    vi.mocked(franc).mockReturnValue('fra')
    expect(detectContentLang('x')).toBe('en')
  })
})

describe('resolveExportLang', () => {
  it('prefers frontmatter lang over content detection', () => {
    // Body is clearly Chinese, but an explicit lang: ko must win.
    expect(resolveExportLang(`---\nlang: ko\n---\n\n${ZH}`)).toBe('ko')
  })

  it('falls back to content detection when there is no frontmatter', () => {
    expect(resolveExportLang(JA)).toBe('ja')
  })

  it('defaults to en when nothing is detectable', () => {
    expect(resolveExportLang('```js\nconst x = 1;\n```')).toBe('en')
  })
})
