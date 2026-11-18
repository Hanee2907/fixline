import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('employee: sees the outage banner, gets fixes while typing, sends a ticket IT can see', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try it as an employee/ }).click();
  await expect(page.getByRole('heading', { name: /what’s going wrong/ })).toBeVisible();
  await expect(page.getByText(/Known issue: VPN outage/)).toBeVisible();

  await page.getByLabel('Describe the problem').fill('My second monitor keeps flickering');
  await expect(page.getByRole('link', { name: /Second monitor not detected or flickering/ })).toBeVisible();
  await expect(page.getByText(/Will go to IT as/)).toContainText('Hardware');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  await page.getByRole('button', { name: 'Send to IT' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My second monitor keeps flickering' })).toBeVisible();
  await expect(page.getByText('Received').first()).toBeVisible();

  // Same demo desk, now as IT: the new ticket is in the queue.
  await page.getByRole('button', { name: /Switch to IT view/ }).click();
  await expect(page.getByRole('link', { name: /My second monitor keeps flickering/ })).toBeVisible();
});
