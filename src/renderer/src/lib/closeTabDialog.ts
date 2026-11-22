import { withDialogLock } from '../store/ui'
import type { t } from '../i18n'

/** The app's typed translator (narrow key union), imported from the i18n module. */
type TFunction = typeof t

// ADR-0040 §8.1: a pure options builder for the aggregate close-window prompt.
// `dialog.confirm` only supports {message, okText, cancelText}; buttons/defaultId/cancelId
// are fixed in the main-process handler and are intentionally not part of this contract.

export function closeTabsDialogOptions(titles: string[], t: TFunction) {
  return {
    message: titles.length
      ? t('app.unsavedCloseTabs', { titles: titles.join(', ') })
      : t('app.unsavedCloseWorkspace'),
    okText: t('app.confirmDiscard'),
    cancelText: t('app.confirmKeep'),
  }
}

/** Ask for a single-tab close. Returns true only when the user chose Discard. */
export async function showCloseTabDialog(title: string, t: TFunction): Promise<boolean> {
  return withDialogLock(async () => {
    try {
      return (
        (await window.api.dialog.confirm({
          message: t('tab.unsaved', { title }),
          okText: t('app.confirmDiscard'),
          cancelText: t('app.confirmKeep'),
        })) === true
      )
    } catch {
      return false
    }
  })
}

/** Ask for the aggregate window-close prompt (Cancel vetoes the whole close). */
export async function showCloseAllTabsDialog(titles: string[], t: TFunction): Promise<boolean> {
  return withDialogLock(async () => {
    try {
      return (await window.api.dialog.confirm(closeTabsDialogOptions(titles, t))) === true
    } catch {
      return false
    }
  })
}
