import { ipcRenderer } from 'electron'
import { onIpc } from './_shared'
import type {
  ReplaceApplyOptions,
  ReplaceApplyOutcome,
  ReplacePlanOptions,
  ReplacePlanOutcome,
  ReplaceProgressPayload,
  ReplaceUndoOutcome,
} from '../../../shared/searchTypes'

// Cross-file replace bridge (ADR-0023). Four channels, in the order the UI drives them:
// plan (async, cancellable, zero writes) → cancel (a REAL channel, not a token in the payload) →
// apply (single-use planId) → undo (session-only, one slot).
export const replaceApi = {
  plan: (options: ReplacePlanOptions): Promise<ReplacePlanOutcome> =>
    ipcRenderer.invoke('search:replace:plan', options),
  apply: (options: ReplaceApplyOptions): Promise<ReplaceApplyOutcome> =>
    ipcRenderer.invoke('search:replace:apply', options),
  cancel: (cancelToken: string): Promise<boolean> =>
    ipcRenderer.invoke('search:replace:cancel', { cancelToken }),
  undo: (): Promise<ReplaceUndoOutcome> => ipcRenderer.invoke('search:replace:undo'),
}

// Progress is PUSHED, not returned: plan runs file-by-file and lets the event loop breathe, so the
// renderer needs the counters while the scan is still in flight.
export function onReplaceProgress(cb: (progress: ReplaceProgressPayload) => void): () => void {
  return onIpc('search:replace:progress', (payload: ReplaceProgressPayload) => cb(payload))
}
