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





Then('I should be redirected to the location-picker screen', async ({ page }) => {
  // AC1: a successful login leaves /login and lands on /select-location.
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  // AC2: the "Select Your Location" prompt is visible after login.
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
});




