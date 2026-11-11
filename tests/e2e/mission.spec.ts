import { expect, test } from '@playwright/test';

const TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuvwxyz';

test('run with Orbit: task to reviewed, committed change through the dashboard', async ({ page }) => {
  await page.goto(`/auth?token=${TOKEN}`);
  await page.getByRole('link', { name: 'Autopilot', exact: true }).click();

  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('What should change?').fill('Document the cart total helper');
  await page.getByLabel('Details and acceptance criteria').fill('Explain what total() returns.');
  await page.getByRole('button', { name: 'Start mission' }).click();

  await expect(page).toHaveURL(/\/missions\/msn_/);
  await expect(page.getByRole('heading', { name: 'Review the changes' })).toBeVisible();
  await expect(page.getByText('ORBIT_DEMO.md').first()).toBeVisible();

  await page.getByRole('button', { name: 'Approve changes' }).click();
  await expect(page.getByRole('heading', { name: 'Approve the pull request' })).toBeVisible();
  await expect(page.getByText(/committed as [0-9a-f]{8}/)).toBeVisible();

  await page.getByRole('button', { name: 'Finish without a pull request' }).click();
  await expect(page.getByText('Completed').first()).toBeVisible();

  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('Mission created from dashboard', { exact: false })).toBeVisible();
});

test('rejects the dashboard API without signing in', async ({ request }) => {
  const res = await request.get('/api/missions');
  expect(res.status()).toBe(401);
});
