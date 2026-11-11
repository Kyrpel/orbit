import { expect, test } from '@playwright/test';

const TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuvwxyz';

for (const theme of ['terminal', 'light']) {
  test(`${theme}: plan approval, file mentions, shell, usage, compact and rewind`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((value) => localStorage.setItem('orbit.theme', value), theme);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const repos = await (await request.get('/api/repos', { headers })).json();
    const repo = repos[0];
    const created = await request.post('/api/chats', {
      headers, data: { repoIds: [repo.id], message: 'Plan a small cart change', mode: 'edit', permissionMode: 'plan' },
    });
    expect(created.ok()).toBe(true);
    const chat = await created.json();
    await page.goto(`/auth?token=${TOKEN}`);
    await page.goto(`/s/${chat.id}`);
    await expect(page.getByText('Ready to code?', { exact: true })).toBeVisible();
    const approve = theme === 'terminal' ? page.getByRole('option', { name: /Yes, and auto-accept commands/ }) : page.getByRole('button', { name: 'Yes, auto-accept commands' });
    await approve.click();
    await expect(page.getByText('Ready to code?', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await (await request.get(`/api/chats/${chat.id}`, { headers })).json()).running).toBe(false);
    const input = page.locator('textarea').first();
    await input.fill('@src/ca');
    const files = page.getByRole('listbox', { name: 'Files', exact: true });
    await expect(files.getByRole('option', { name: '@src/cart.js', exact: true })).toBeVisible();
    await files.getByRole('option', { name: '@src/cart.js', exact: true }).click();
    await expect(input).toHaveValue('@src/cart.js ');

    await input.fill('!echo session-shell-ok');
    await input.press('Enter');
    await expect.poll(async () => {
      const detail = await (await request.get(`/api/chats/${chat.id}`, { headers })).json();
      return detail.messages.find((m: { kind: string; status: string }) => m.kind === 'shell' && m.status === 'done')?.content;
    }).toContain('session-shell-ok');
    await input.fill('/cost');
    await input.press('Enter');
    await expect(page.getByText(/Reported cost: \$0\.0000/)).toBeVisible();
    await input.fill('/context');
    await input.press('Enter');
    await expect(page.getByText('No context size recorded yet: send a message first.', { exact: true })).toBeVisible();
    await input.fill('/compact');
    await input.press('Enter');
    await expect(page.getByText('Conversation compacted', { exact: true })).toBeVisible();

    await input.fill('/rewind');
    await input.press('Enter');
    await page.getByRole('option', { name: /The plan is approved/ }).click();
    await page.getByRole('option', { name: /Restore code and conversation/ }).click();
    await expect(input).toHaveValue('The plan is approved. Go ahead and implement it now.');
    await expect(page.getByText('Conversation compacted', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `test-results/session-${theme}.png`, fullPage: true });
    await input.fill('/init');
    await input.press('Enter');
    await expect.poll(async () => {
      const detail = await (await request.get(`/api/chats/${chat.id}`, { headers })).json();
      return detail.messages.some((m: { role: string; content: string }) => m.role === 'user' && m.content.includes('write its instructions file for AI coding agents')) && !detail.running;
    }).toBe(true);
    // Selecting Plan for the next run must not ask to approve an earlier editing answer.
    await input.fill('/plan');
    await input.press('Enter');
    await expect.poll(async () => (await (await request.get(`/api/chats/${chat.id}`, { headers })).json()).permissionMode).toBe('plan');
    await expect(page.getByText('Ready to code?', { exact: true })).toHaveCount(0);
    await input.press('Shift+Tab');
    await expect.poll(async () => (await (await request.get(`/api/chats/${chat.id}`, { headers })).json()).mode).toBe('ask');
    await expect(page.getByText('Ready to code?', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
