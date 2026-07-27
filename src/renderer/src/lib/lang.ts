// Document language resolution for the exported/printed HTML <html lang> attribute.
// Priority: 1) explicit `lang:` in YAML frontmatter, 2) statistical detection of the
// content via `franc`, 3) default 'en'.
import { franc } from 'franc'

// Map franc's ISO 639-3 output to BCP 47 tags we care about. Anything else falls back to 'en'.
const ISO3_TO_BCP47: Record<string, string> = {
  cmn: 'zh-CN',
  jpn: 'ja',
  kor: 'ko',
  eng: 'en',
}

// Pull a `lang:` value out of a leading YAML frontmatter block (--- ... ---).
// Returns null when there is no frontmatter or no usable lang field.
export function extractFrontmatterLang(content: string): string | null {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!block) return null
  const match = block[1].match(/^\s*lang:\s*['"]?([A-Za-z]+(?:-[A-Za-z]+)*)/m)
  if (!match) return null
  const lang = match[1]
  // Only accept a permissive BCP 47-ish tag to avoid propagating junk.
  return /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(lang) ? lang : null
}

// Detect the language of arbitrary text. HTML tags and code (fenced / inline) are
// stripped first so code blocks don't bias a CJK document toward English.
export function detectContentLang(input: string): string {
  const text = input
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
  const code = franc(text)
  return ISO3_TO_BCP47[code] ?? 'en'
}

// Resolve the language for export: frontmatter wins, then content detection, then 'en'.
export function resolveExportLang(content: string): string {
  return extractFrontmatterLang(content) ?? detectContentLang(content)
}
