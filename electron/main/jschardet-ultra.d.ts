// jschardet-ultra ships no official types, so we add a minimal declaration for
// use in the main process.
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
