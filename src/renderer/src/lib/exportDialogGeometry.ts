// Geometry of the UNPOSITIONED export dialog. Kept out of ExportDialog.tsx so the component file
// exports only a component (react-refresh/only-export-components) and so the pure arithmetic can
// be unit-tested directly (docs/agents/testing.md, "Assert the logic you wrote").

export type DialogRect = { x: number; y: number; w: number; h: number }

// ONE set of tokens: both the inline CSS values and the rect frozen on the first interaction are
// derived from them, so the two cannot drift (ADR-0024 §1.5 "Design tokens live in exactly one
// place; two copies of a token drift"). Rejected alternative: CSS custom properties in globals.css
// — jsdom has no cascade, so the fallback could not be locked by a pure unit test, and a stub
// cannot prove the real path.
export const DIALOG_DEFAULT_GEOMETRY = {
  widthVw: 92,
  maxWidthPx: 1120,
  heightVh: 88,
  maxHeightPx: 960,
} as const

export const DIALOG_DEFAULT_CSS = {
  width: `min(${DIALOG_DEFAULT_GEOMETRY.widthVw}vw, ${DIALOG_DEFAULT_GEOMETRY.maxWidthPx}px)`,
  height: `min(${DIALOG_DEFAULT_GEOMETRY.heightVh}vh, ${DIALOG_DEFAULT_GEOMETRY.maxHeightPx}px)`,
} as const

/** Pure: the centred rect those CSS values produce at a given viewport. */
export function defaultDialogRect(vw: number, vh: number): DialogRect {
  const { widthVw, maxWidthPx, heightVh, maxHeightPx } = DIALOG_DEFAULT_GEOMETRY
  const w = Math.min((widthVw / 100) * vw, maxWidthPx)
  const h = Math.min((heightVh / 100) * vh, maxHeightPx)
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h }
}
