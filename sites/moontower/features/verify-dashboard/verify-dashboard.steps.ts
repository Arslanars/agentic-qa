// Step definitions for features/verify-dashboard/verify-dashboard.feature.
//
// Reuse over recreate (framework Rule 2/9): the login step wraps the EXISTING
// LoginPage POM (pages/login-user/LoginPage.ts) — this app already had a proven
// login object, so we don't duplicate its selectors. The two new screens
// (location picker, dashboard) get their own POMs under pages/verify-dashboard/.

import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { LocationPickerPage } from '../../pages/verify-dashboard/LocationPickerPage';

// Scope these step definitions to the @dashboard feature tag so the same step
// phrases (e.g. `I should see the heading {string}`) can also exist in the
// @login feature without colliding in Cucumber's global step pool.
//
// Login, location choice and the dashboard-URL assertion now come from
// features/_shared/common.steps.ts, which is why this file no longer needs
// LoginPage, DashboardPage or the credential constants.
const { Then } = createBdd(undefined, { tags: '@dashboard' });





Then('I should be redirected to the location-picker screen', async ({ page }) => {
  // AC1: a successful login leaves /login and lands on /select-location.
  const picker = new LocationPickerPage(page);
  await picker.expectLoaded();
});

Then('I should see the heading {string}', async ({ page }, name: string) => {
  // AC2: the "Select Your Location" prompt is visible after login.
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
});




