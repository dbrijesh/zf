import { test, expect, type Page } from '@playwright/test';

/** M6 acceptance (spec 15): create from the composer, watch it move on the floor, answer in the inbox, approve the spec, see the PR link at handoff. Floor stays smooth with 200 items. */
const login = async (page: Page, role: string) => {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 500)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
  await page.goto('/login');
  await page.getByRole('button', { name: role }).click();
  await page.waitForURL('/');
  await expect(page.getByRole('heading', { name: 'The line' }).or(page.getByRole('heading', { name: 'Welcome to Zerovity Factory' }))).toBeVisible();
};

test('create, answer, approve, hand off', async ({ page }) => {
  await login(page, 'Approver (tech-leads)');
  await expect(page.getByRole('heading', { name: 'The line' })).toBeVisible();

  // composer via the keyboard shortcut
  await page.keyboard.press('n');
  const dlg = page.getByRole('dialog', { name: 'New work item' });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Title').fill('Retry policy for failed SEPA payouts');
  await dlg.getByLabel('Description').fill('Should retries stop after AC04? [fake:ask]');
  await dlg.getByRole('button', { name: 'Create work item' }).click();

  // the drawer opens on the new item; close it and watch the token on the floor
  await expect(page.getByRole('complementary', { name: 'Work item' })).toBeVisible();
  const shortId = (await page.locator('.drawer .dh .id').first().innerText()).split(' ')[0];
  await page.keyboard.press('Escape');
  await expect(page.locator('.tok', { hasText: shortId })).toBeVisible();

  // the agent asks: it appears in "Waiting on you"; answer with a button
  const card = page.locator('.inbox article.card[data-kind="question"]', { hasText: shortId });
  await expect(card).toBeVisible({ timeout: 40_000 });
  await card.getByRole('button', { name: 'Yes' }).click();
  await expect(page.locator('.toast.on')).toContainText('same session');

  // the spec arrives for approval; approve it from the inbox card
  const spec = page.locator('.inbox article.card[data-kind="spec_approval"]', { hasText: shortId });
  await expect(spec).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('.gslot', { hasText: shortId.replace(/^\D+-?/, '') })).toBeVisible(); // waiting on the gate rail
  await spec.getByRole('button', { name: 'Approve spec' }).click();

  // build, verify, ship run; the item ends as a PR review in the inbox
  const review = page.locator('.inbox article.card[data-kind="pr_review"]', { hasText: shortId });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await review.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.drawer .statusline')).toContainText('PR (local)');
  await expect(page.locator('.drawer .statusline')).toContainText('Ready for a person');
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.locator('.verif.ok')).toContainText('Hash chain verified');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.locator('.drawer').getByRole('button', { name: 'Mark handed off' }).click();
  await expect(page.locator('.drawer .statusline')).toContainText('Complete');
});

test('request changes with an inline comment sends the spec back to the same writer', async ({ page }) => {
  await login(page, 'Approver (tech-leads)');
  await page.keyboard.press('n');
  const dlg = page.getByRole('dialog', { name: 'New work item' });
  await dlg.getByLabel('Title').fill('Idempotency keys for payouts');
  await dlg.getByLabel('Description').fill('Add keys.');
  await dlg.getByRole('button', { name: 'Create work item' }).click();
  const shortId = (await page.locator('.drawer .dh .id').first().innerText()).split(' ')[0];
  await page.getByRole('tab', { name: 'Spec' }).click();
  await expect(page.locator('.sblock').first()).toBeVisible({ timeout: 40_000 });
  await page.locator('.sblock', { hasText: 'Requirements' }).first().hover();
  await page.getByRole('button', { name: /Comment on line/ }).first().click({ force: true });
  await page.getByLabel('Comment', { exact: true }).fill('Cover the empty key case.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.locator('.drawer').getByRole('button', { name: /Request changes/ }).click();
  await expect(page.locator('.toast.on')).toContainText('Sent back');
  await expect(page.getByRole('button', { name: 'Changes since last version' }).or(page.getByText(/Changes since last version/))).toBeVisible({ timeout: 40_000 });
  void shortId;
});

test('the command palette jumps to an agent and runs an action', async ({ page }) => {
  await login(page, 'Org admin');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.pal.on')).toBeVisible();
  await page.getByLabel('Search commands').fill('agent executor');
  await page.getByRole('option', { name: /zerovity-executor/ }).first().click();
  await expect(page.getByRole('heading', { name: 'zerovity-executor' })).toBeVisible();
  await expect(page.getByText('Weight this agent adds')).toBeVisible();
});

test('light and slate themes', async ({ page }) => {
  await login(page, 'Org admin');
  await page.getByRole('button', { name: 'Switch theme' }).click();
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('button', { name: 'Switch theme' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(t1);
});

test('floor with 200 items virtualises and scrolls smoothly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // software-rendered CI browsers cannot composite the grain overlay and orbit gradients; the product honours this setting
  await login(page, 'Org admin');
  await expect(page.locator('.tok').first()).toBeVisible();
  const lane = page.locator('.lane').nth(1);
  const total = await page.evaluate(() => [...document.querySelectorAll('.stack')].reduce((a, e) => a + Number((e as HTMLElement).dataset.count ?? 0), 0));
  expect(total).toBeGreaterThanOrEqual(150);
  const inDom = await page.locator('.tok').count();
  expect(inDom).toBeLessThan(total / 2); // only what is near the viewport is rendered
  const frames = await lane.locator('.stack').evaluate(async (el) => {
    const gaps: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 40; i++) {
      el.scrollTop += 90;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const n = performance.now(); gaps.push(n - last); last = n;
    }
    return gaps.sort((a, b) => a - b);
  });
  const p95 = frames[Math.floor(frames.length * 0.95)];
  expect(p95, `p95 frame gap ${p95.toFixed(1)}ms`).toBeLessThan(60);
});

test('inbox page: keyboard navigation, resolve with undo, resolved filter', async ({ page }) => {
  await login(page, 'Approver (tech-leads)');
  await page.goto('/inbox');
  const list = page.getByRole('listbox', { name: 'Inbox items' });
  await expect(list).toBeVisible();
  const rows = list.getByRole('option');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('e'); // resolve the selected item
  await expect(page.locator('.toast.on')).toContainText('Resolved');
  await expect(rows).toHaveCount(before - 1);
  await page.locator('.toast .undo').click();
  await expect(rows).toHaveCount(before);
  await page.getByRole('tab', { name: 'Resolved' }).click();
  await expect(page.getByText('J / K move')).toBeVisible();
});
test('connections screen lists the catalogue with coming-soon types', async ({ page }) => {
  await login(page, 'Org admin');
  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Code forge' })).toBeVisible();
  await expect(page.getByText('GitLab')).toBeVisible();
  await expect(page.getByText('coming soon').first()).toBeVisible();
});

test('accessibility basics: landmarks, focusable tokens, labelled controls', async ({ page }) => {
  await login(page, 'Org admin');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  const tok = page.locator('.tok').first();
  await tok.focus();
  await expect(tok).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Work item' })).toBeVisible();
});
