import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function a11y(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${label}: ${v.id} · ${v.nodes[0]?.target}`)).toEqual([]);
}

test('sign-in page is accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await a11y(page, 'sign in');
});

test('IT agent: live queue, saved reply, resolve as a guide', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try it as IT staff/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.locator('.row').first()).toBeVisible();
  await a11y(page, 'inbox (dark)');

  await page.getByRole('link', { name: /Outlook keeps asking for password/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Outlook keeps asking for password' })).toBeVisible();
  await expect(page.getByRole('timer')).toContainText('to first response'); // "left to …" by day, "… after hours" at night
  await expect(page.getByText('Clear old passwords from Credential Manager')).toBeVisible();

  // Saved reply with the keyboard, sent with Ctrl+Enter.
  await page.keyboard.press('r');
  await page.keyboard.type('/remote');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText(/I can take a look remotely/)).toBeVisible();
  await expect(page.getByRole('timer')).toContainText('to fix');

  await page.keyboard.press('Escape'); // leave the reply box, so E means "resolve"
  await page.keyboard.press('e');
  await page.getByLabel('What fixed it').fill('Cleared the old password and restarted Outlook.');
  await page.getByLabel('Save this fix as a knowledge base guide').check();
  await page.getByRole('button', { name: '✓ Resolve' }).click();
  await expect(page.getByText('✓ Resolved')).toBeVisible();

  await page.getByRole('link', { name: 'Knowledge base' }).click();
  await expect(page.getByRole('link', { name: /Outlook keeps asking for password/ })).toBeVisible();

  await page.getByRole('button', { name: /Switch to light mode/ }).click();
  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await a11y(page, 'inbox (light)');
});

test('Ctrl+K finds tickets and pages', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try it as IT staff/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('printer');
  await expect(page.getByRole('option', { name: /Label printer offline/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: /printer/i })).toBeVisible();
});

test('attachments, email in and out, and working hours settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try it as IT staff/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // The demo's screenshot shows on Maya's ticket; attach another to a note.
  await page.getByRole('link', { name: /Outlook keeps asking for password/ }).first().click();
  await expect(page.getByRole('img', { name: 'outlook-password-prompt.png' })).toBeVisible();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('.composer input[type=file]').setInputFiles({ name: 'event-log.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('event-log.png')).toBeVisible();
  await page.getByRole('button', { name: '🔒 Note' }).click();
  await page.getByLabel('Internal note').fill('Event log attached');
  await page.getByRole('button', { name: /Add note/ }).click();
  await expect(page.getByRole('img', { name: 'event-log.png' })).toBeVisible();

  // Email into the desk becomes a ticket; the confirmation is in the outbox.
  await page.getByRole('link', { name: 'Settings & security' }).click();
  await expect(page.getByRole('heading', { name: /Working hours/ })).toBeVisible();
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByText('It arrived as a new ticket in the queue.')).toBeVisible();
  await expect(page.getByText(/We got your request: Laptop won’t connect/)).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
});

test('forgot password answers the same for any email', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Work email').fill('nobody@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If that email has an account');
});
