// Step definitions shared by every feature.
//
// Why this file exists: step definitions in this repo are tag-scoped —
// `createBdd(undefined, { tags: '@login' })` makes a step available only to
// @login scenarios. That forced each feature to keep its own copy of common
// steps, and "I am on the Moontower login page" ended up written four times.
//
// These are declared with a bare `createBdd()`, so they are GLOBAL: available
// to every scenario regardless of tags. Only steps whose implementations were
// byte-identical across every feature that defined them live here.
//
// Deliberately NOT moved, because their implementations genuinely differ per
// feature — merging them would change behaviour:
//   - "I should be redirected to the location-picker screen"   (3 variants)
//   - "I should see the heading {string}"                      (2 variants)
//   - "I sign in with email {string} and password {string}"    (2 variants)
//   - "I click the {string} link"                              (2 variants)
//   - "I select the {string} location"                         (2 variants)
//
// Adding a step here makes it global. Before doing so, confirm no feature
// defines the same phrase locally — two definitions of one phrase is an
// ambiguous-step error at run time, not a silent override.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { LoginPage } from '../../pages/login-user/LoginPage';
import { LocationPickerPage } from '../../pages/verify-dashboard/LocationPickerPage';
import { DashboardPage } from '../../pages/verify-dashboard/DashboardPage';

const { Given, When, Then } = createBdd();

// Credentials for the shared login step. Same env vars and same fallbacks the
// per-feature copies used, so behaviour is unchanged — now in one place, which
// is also what makes moving them out of source control a single edit later.
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

Then('the URL should match {string}', async ({ page }, pattern: string) => {
  await expect(page).toHaveURL(new RegExp(pattern), { timeout: 10_000 });
});

Then('the URL should match the homepage', async ({ page }) => {
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
});

Then('the dashboard URL should be {string}', async ({ page }, expectedUrl: string) => {
  // AC3: clicking "Main Location" must route to the inventory-vendors dashboard.
  const dashboard = new DashboardPage(page);
  await dashboard.expectLoaded();
  await expect(page, 'AC3: dashboard URL must equal the inventory-vendors route').toHaveURL(expectedUrl, {
    timeout: 20_000,
  });
});
