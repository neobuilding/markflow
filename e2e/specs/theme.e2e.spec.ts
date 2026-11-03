import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForAppReady, closeApp, forceEnglish, AppHandle } from '../helpers/launch'

// The theme entry (ADR-0028): the native View -> Theme submenu is the app's only user-facing
// theme control. These specs drive the FULL loop - native menu -> renderer store -> the `dark`
// class on <html> - because each hop can break on its own: the menu can stop forwarding the
// pick, the renderer can stop applying it, and the "follow the system" path can stop listening
// to the OS.
//
// The menu labels are localized, so every spec pins English first (forceEnglish) and then reads
// the English labels - the Chinese UI carries the very same entries under their own names.

/** Whether the app chrome currently renders in the dark theme. */
function isDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains('dark'))
}

/** The theme the renderer store currently holds. */
function storedTheme(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__uiStore.getState().theme)
}

/** The three entries of the native View -> Theme submenu, with their radio state. */
function themeEntries(
  handle: AppHandle,
): Promise<{ label: string; type: string; checked: boolean }[]> {
  return handle.electronApp.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View')
    const theme = view?.submenu?.items.find((i) => i.label === 'Theme')
    return (theme?.submenu?.items ?? []).map((i) => ({
      label: i.label ?? '',
      type: i.type ?? '',
      checked: i.checked === true,
    }))
  })
}

test.describe('theme entry (ADR-0028)', () => {
  let handle: AppHandle
  test.beforeEach(async () => {
    handle = await launchApp()
  })
  test.afterEach(async () => {
    await closeApp(handle)
  })

  test('the Theme submenu offers exactly the three choices, with the current one checked', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await forceEnglish(page)

    // Light / Dark / System, as ONE radio group. The default is "System" (follow the OS), so that
    // is the entry that starts checked.
    await expect
      .poll(() => themeEntries(handle), {
        message: 'the Theme submenu must expose three radio entries',
      })
      .toEqual([
        { label: 'Light', type: 'radio', checked: false },
        { label: 'Dark', type: 'radio', checked: false },
        { label: 'System', type: 'radio', checked: true },
      ])
  })

  test('picking Dark in the native menu turns the app dark end to end', async () => {
    const { page } = handle
    await waitForAppReady(page)
    await forceEnglish(page)
    await expect.poll(() => themeEntries(handle)).not.toEqual([])

    // Activate the menu item exactly as the OS does on a real click.
    await handle.electronApp.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View')
      const theme = view?.submenu?.items.find((i) => i.label === 'Theme')
      theme?.submenu?.items.find((i) => i.label === 'Dark')?.click()
    })

    // The pick reaches the renderer...
    await expect.poll(() => storedTheme(page)).toBe('dark')
    // ...and the chrome follows it.
    await expect.poll(() => isDark(page)).toBe(true)
    // ...and the menu's radio group shows the current choice.
    await expect
      .poll(async () => (await themeEntries(handle)).filter((e) => e.checked).map((e) => e.label))
      .toEqual(['Dark'])
  })

  test('the renderer applies an explicit choice', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('light'))
    await expect.poll(() => isDark(page)).toBe(false)

    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
    await expect.poll(() => isDark(page)).toBe(true)
  })

  test('"system" follows the OS preference', async () => {
    const { page } = handle
    await waitForAppReady(page)

    // The renderer resolves "system" through the very same media query the OS reports to.
    const osPrefersDark = await page.evaluate(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    )

    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('system'))
    await expect.poll(() => isDark(page)).toBe(osPrefersDark)
  })

  test('the theme choice is not persisted across launches (ADR-0028 R-f)', async () => {
    const { page } = handle
    await waitForAppReady(page)

    await page.evaluate(() => (window as any).__uiStore.getState().setTheme('dark'))
    await expect.poll(() => isDark(page)).toBe(true)

    // Nothing about the choice reaches persistent storage (the UI store has no `persist`
    // middleware), so the next launch starts at the default again.
    const persisted = await page.evaluate(() => {
      const entries: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key) entries.push(key)
      }
      return entries.filter((k) => k.toLowerCase().includes('theme'))
    })
    expect(persisted).toEqual([])
  })
})
