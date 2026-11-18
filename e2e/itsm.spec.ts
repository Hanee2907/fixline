import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** No serious or critical accessibility problems on the page as it is now. */
async function accessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

test('employee: says what they need in plain words, gets the form filled in, and approves their team', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try it as an employee/ }).click();
  await expect(page.getByText(/Planned work: Restart Plant 2 VPN gateway/)).toBeVisible();

  await page.getByLabel('Describe the problem').fill('I need Visio for drawing floor plans');
  await page.getByRole('button', { name: /New software.*filled in from what you typed/ }).click();
  await expect(page.getByLabel(/^Software/)).toHaveValue('Visio');
  await expect(page.getByLabel(/What it’s for/)).toHaveValue('Drawing floor plans');
  await accessible(page);
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New software: Visio' })).toBeVisible();
  await expect(page.getByText(/Waiting for .+ to approve/)).toBeVisible();

  // Maya manages Sara: approve her Acrobat request.
  await page.getByRole('link', { name: /Approvals/ }).click();
  await expect(page.getByText('New software: Adobe Acrobat Pro')).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: '✓ Approve' }).click();
  await expect(page.getByText('Nothing waiting')).toBeVisible();

  await page.getByRole('link', { name: 'My devices' }).click();
  await expect(page.getByText('LT-0231')).toBeVisible();
  await accessible(page);
});

test('IT: devices, problems, changes, automation and the audit log', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try it as IT staff/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

  // The device behind Maya's ticket keeps coming back.
  await page.getByRole('link', { name: 'Devices' }).click();
  await expect(page.getByText('4 tickets in 30 days. Consider replacing it.')).toBeVisible();
  await accessible(page);

  // Repeat tickets are spotted without anyone noticing them by hand.
  await page.getByRole('link', { name: 'Problems' }).click();
  await expect(page.getByText('Spotted in the last 3 days')).toBeVisible();
  await page.getByRole('button', { name: 'Group them as a problem' }).first().click();
  await page.getByRole('button', { name: 'Create problem' }).click();
  await expect(page.getByRole('heading', { name: 'Cause and workaround' })).toBeVisible();
  await accessible(page);

  // Risk is worked out while you type.
  await page.getByRole('link', { name: 'Changes' }).click();
  await page.getByRole('button', { name: '+ Plan a change' }).click();
  await page.getByLabel('What’s changing').fill('Replace the core firewall');
  await page.getByLabel('What it affects').fill('Internet for everyone');
  await expect(page.getByText(/(Medium|High) risk/)).toBeVisible();
  await expect(page.getByText('Touches a service many people rely on')).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Rules are tested on last month's tickets before they go live.
  await page.getByRole('link', { name: 'Automation' }).click();
  await expect(page.getByText('Printers go to Jordan')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).nth(1).click();
  await page.getByRole('button', { name: /Test on last month/ }).click();
  await expect(page.getByText(/tickets from the last 30 days would have matched/)).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText(/failed to sign in/)).toBeVisible();
  await accessible(page);
});
