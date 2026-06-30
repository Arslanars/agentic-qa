// Step definitions for features/verify-dashboard/verify-dashboard.feature.
//
// Reuse over recreate (framework Rule 2/9): the login step wraps the EXISTING
// LoginPage POM (pages/login-user/LoginPage.ts) — this app already had a proven
// login object, so we don't duplicate its selectors. The two new screens
// (location picker, dashboard) get their own POMs under pages/verify-dashboard/.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { LoginPage } from '../../pages/login-user/LoginPage';
import { LocationPickerPage } from '../../pages/verify-dashboard/LocationPickerPage';
import { DashboardPage } from '../../pages/verify-dashboard/DashboardPage';

// Scope these step definitions to the @dashboard feature tag so the same step
// phrases (e.g. `I should see the heading {string}`) can also exist in the
// @login feature without colliding in Cucumber's global step pool.
const { Given, When, Then } = createBdd(undefined, { tags: '@dashboard' });

// Credentials are read from the environment with safe fallbacks (same
// convention as the login-user feature) — never hard-coded in the .feature.
const EMAIL = process.env.MOONTOWER_LOGIN_EMAIL || 'developers@moontower.com';
const PASSWORD = process.env.MOONTOWER_LOGIN_PASSWORD || '12345678';

Given('I am on the Moontower login page', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.expectLoaded();
});

When('I log in with the provided Moontower credentials', async ({ page }) => {
  const login = new LoginPage(page);
  await login.login(EMAIL, PASSWORD);
});

Then('I should be redirected to the location-picker screen', async ({ page }) => {
  // AC1: a successful login leaves /login and lands on /select-location.
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  // AC2: the "Select Your Location" prompt is visible after login.
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
});

When('I choose the {string} option', async ({ page }, label: string) => {
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
  if (/main location/i.test(label)) {
    await picker.selectMainLocation();
  } else {
    // Fall back to a role-based match so the step works if more locations appear.
    await page.getByRole('button', { name: label }).click();
  }
});

Then('the dashboard URL should be {string}', async ({ page }, expectedUrl: string) => {
  // AC3: clicking "Main Location" must route to the inventory-vendors dashboard.
  const dashboard = new DashboardPage(page);
  await dashboard.expectLoaded();
  await expect(page, 'AC3: dashboard URL must equal the inventory-vendors route').toHaveURL(expectedUrl, {
    timeout: 20_000,
  });
});
