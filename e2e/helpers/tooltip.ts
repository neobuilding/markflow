import { expect, type Page, type Locator } from '@playwright/test'

/**
 * Hover a trigger and return its tooltip.
 *
 * The tooltip opens on a **pointermove** over the trigger, so a hover that lands while the renderer
 * is janky is simply LOST — the bubble then never opens, no matter how long the test waits. Under the
 * suite's parallel load (one shared Vite dev server, one Electron instance per worker) that race is
 * real and non-deterministic: a single bare `.hover()` can lose its pointermove.
 *
 * So each hover attempt is made resilient (see `summonTooltip`) AND retried by the callers'
 * `expect.poll` until the bubble is actually on screen. The assertion itself stays strict — the caller
 * still checks the tooltip's text or colours; only the way the bubble is summoned changes.
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
        await summonTooltip(page, testId)
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
        await summonTooltip(page, testId)
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
        await summonTooltip(page, testId)
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

/**
 * One resilient hover attempt.
 *
 * A bare `page.getByTestId(id).hover()` dispatches the pointermove, and under parallel load the
 * renderer can drop it — Radix then never opens the bubble. Two extra settles make each attempt
 * actually land:
 *
 *   1. park the pointer at (0,0) and wait a tick — lets any previous bubble finish fading and lets the
 *      page register the pointer leaving, so Radix's pointer-grace state is cleared and the next
 *      trigger's pointermove is not swallowed;
 *   2. after moving onto the trigger, wait a tick — lets the renderer process the pointermove and Radix
 *      open the (animated) bubble before the caller reads it.
 *
 * The hover itself is given a short timeout and swallowed, so a momentarily non-actionable trigger
 * fails this attempt fast and the surrounding `expect.poll` simply retries on the next tick. Retrying
 * the whole sequence is what survives the race a single attempt cannot.
 */
async function summonTooltip(page: Page, testId: string): Promise<void> {
  const trigger = page.getByTestId(testId)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(30)
  await trigger.hover({ timeout: 2000 }).catch(() => {})
  await page.waitForTimeout(30)
}
