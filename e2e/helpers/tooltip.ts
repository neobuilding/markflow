import { expect, type Page, type Locator } from '@playwright/test'

/**
 * Hover a trigger and return its tooltip.
 *
 * The tooltip opens on a **pointermove** over the trigger, so a hover that lands before the
 * trigger is mounted is simply LOST — the bubble then never opens, no matter how long the test
 * waits for it. Under the suite's parallel load (one shared Vite dev server, one Electron instance
 * per worker) that race is real: the renderer can still be mounting when the test hovers.
 *
 * So the hover is RETRIED until the bubble is actually on screen. The assertion itself stays
 * strict — the caller still checks the tooltip's text or colours; only the way the bubble is
 * summoned becomes resilient.
 *
 * @param testId  the trigger's test id
 * @param hasText optional text the tooltip must contain (used to pick the right bubble when
 *                several may be mounted at once)
 */
export async function hoverTooltip(page: Page, testId: string, hasText?: string): Promise<Locator> {
  const tip = hasText ? page.getByRole('tooltip').filter({ hasText }) : page.getByRole('tooltip')
  await expect
    .poll(
      async () => {
        // Park the pointer away from the bar first, so the previous bubble is gone and the
        // assertion cannot latch onto it (it fades out asynchronously).
        await page.mouse.move(0, 0)
        await page.getByTestId(testId).hover()
        return tip.first().isVisible()
      },
      { timeout: 20_000, message: `tooltip of ${testId}` },
    )
    .toBe(true)
  return tip
}

/**
 * Assert that a trigger's tooltip carries `expected` — the hover and the read are ONE step, so a
 * re-render that unmounts the bubble between them cannot produce a half-read result.
 */
export async function expectTooltipText(
  page: Page,
  testId: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.mouse.move(0, 0)
        await page.getByTestId(testId).hover()
        const tip = page.getByRole('tooltip')
        if (!(await tip.first().isVisible())) return false
        return (await tip.first().textContent())?.includes(expected) ?? false
      },
      { timeout: 20_000, message: `tooltip of ${testId}` },
    )
    .toBe(true)
}

/**
 * Read the tooltip's computed colours in ONE atomic step: the hover, the visibility check and the
 * read happen together, so a bubble that unmounts mid-read can never yield a value read from a
 * detached node (`getComputedStyle` on such a node returns "" for every property).
 */
export async function readTooltipColors(
  page: Page,
  testId: string,
): Promise<{ bg: string; fg: string; border: string }> {
  let colors: { bg: string; fg: string; border: string } | null = null
  await expect
    .poll(
      async () => {
        await page.mouse.move(0, 0)
        await page.getByTestId(testId).hover()
        const tip = page.getByRole('tooltip')
        if (!(await tip.first().isVisible())) return false
        colors = await tip
          .first()
          .evaluate((el) => {
            const cs = getComputedStyle(el)
            return {
              bg: cs.backgroundColor,
              fg: cs.color,
              border: cs.borderTopColor,
            }
          })
          .catch(() => null)
        return colors !== null && colors.bg !== '' && colors.fg !== ''
      },
      { timeout: 20_000, message: `tooltip colours of ${testId}` },
    )
    .toBe(true)
  return colors as unknown as { bg: string; fg: string; border: string }
}
