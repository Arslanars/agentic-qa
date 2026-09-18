// Step definitions for sites/saucedemo/features/login/login.feature.
//
// Tag-scoped to @sauce-login. Scoping is what keeps two sites' step libraries
// apart: this file's "I sign in as {string}" is invisible to every Moontower
// scenario, and Moontower's steps are invisible here.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { SauceLoginPage } from '../../pages/login/SauceLoginPage';
import { InventoryPage } from '../../pages/login/InventoryPage';

const { Given, When, Then } = createBdd(undefined, { tags: '@sauce-login' });

// Sauce Demo publishes one shared password for all of its demo accounts.
const PASSWORD = process.env.SAUCEDEMO_PASSWORD || 'secret_sauce';

Given('I am on the Sauce Demo login page', async ({ page }) => {
  const login = new SauceLoginPage(page);
  await login.goto();
  await login.expectLoaded();
});

When('I sign in as {string}', async ({ page }, user: string) => {
  await new SauceLoginPage(page).login(user, PASSWORD);
});

Then('I should land on the product list', async ({ page }) => {
  await new InventoryPage(page).expectLoaded();
});

Then('I should see the error {string}', async ({ page }, message: string) => {
  await expect(page.getByText(message)).toBeVisible({ timeout: 15_000 });
});
