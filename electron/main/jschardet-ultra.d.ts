// jschardet-ultra 无官方类型，这里补一个最小声明供主进程使用。
declare module 'jschardet-ultra' {
  export interface DetectionResult {
    encoding: string | null
    confidence: number
  }
  export function detect(input: Buffer | string | number[]): DetectionResult
  export function detectAll(input: Buffer | string | number[]): DetectionResult[]
  export function normalizeEncoding(encoding: string): string
  export function encodingExists(encoding: string): boolean
}
